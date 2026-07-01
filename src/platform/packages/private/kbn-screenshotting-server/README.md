# @kbn/screenshotting-server

Stateless code pertaining to the capture of screenshots for Kibana Reporting.

---

# Multi-Tenant Reporting Service — POC

> **Status:** Proof of concept on a private branch. **Not for merge to `main`.**
> The goal is to prove the core idea works locally so the team can see it run, ask
> questions, and make decisions. It is intentionally incomplete — see
> [What we did NOT do](#what-we-did-not-do) and [Open decisions](#open-decisions).

This package is the natural seam for the reporting-service work because it already owns the
stateless screenshot-capture concerns (Chromium config, args, binary paths). The POC adds a
config-gated path that makes Kibana call an **external HTTP service** to render reports instead
of launching Chromium in-process. The service is split into a **three-tier topology** — Kibana →
an **API/router tier** → one or more **render workers** — with rendered artifacts persisted to
**Elasticsearch** (never held in service memory).

## Contents

- [Background: Mike Cote's proposal](#background-mike-cotes-proposal)
- [Architecture (three tiers)](#architecture-three-tiers)
- [What this POC does](#what-this-poc-does)
- [How to run the POC](#how-to-run-the-poc)
- [What works / what doesn't](#what-works--what-doesnt)
- [Current browser lifecycle & isolation](#current-browser-lifecycle--isolation)
- [Options to explore & decisions to make](#options-to-explore--decisions-to-make)
- [What we did NOT do](#what-we-did-not-do)
- [Open decisions (ledger)](#open-decisions)

---

## Background: Mike Cote's proposal

> **Source:** Mike Cote's Google Doc, [*"Multi-Tenant Reporting Service"*](https://docs.google.com/document/d/19TjvWwLG4Wtq_xJQmzpGyjdqpKkHaGTx-_15DHaAmVw)
> status "Under review". Tracking epic: `elastic/kibana-team#1847` (Scheduled reporting in
> Serverless). A local, annotated copy lives outside this branch (kept local, not pushed).

Kibana relies on Chromium to render PNG/PDF reports. Running a browser server-side is the only
reliable way to capture complex dashboard layouts, inject styling, and render every vis type —
but it is expensive and risky. Mike's proposal is to extract that into a standalone,
multi-tenanted **Reporting Service**.

**Problems it solves**

1. **Reporting is disabled in Serverless.** Chromium's CPU/memory cost, multiplied across every
   single-tenant project, hurts margins too much to enable it everywhere.
2. **Poor security posture.** Chromium is a large, frequently-CVE'd attack surface. Hosted/ECH
   customers run old Kibana versions with outdated Chromium, and the current RCE-patch process is
   "non-standard, arduous, and fragile."
3. **Maintenance burden.** Keeping Kibana + Puppeteer/Playwright compatible with a specific
   Chromium DevTools Protocol version is brittle.

**The proposal**

Build a multi-tenanted Reporting Service that encapsulates Chromium + its automation layer,
fully decouples rendering from Kibana, and exposes a **stable, versioned HTTP API**. When a
reporting task runs, Kibana sends an HTTP request containing everything needed to navigate and
capture; the service manages Chromium and returns the artifact.

```
Kibana (reporting task)
  └─ HTTP request → Multi-Tenant Reporting Service
                       ├─ spawns / manages Chromium
                       ├─ renders the page
                       └─ returns artifact bytes (or a reference)
```

**Key benefits Mike calls out**

- **Operational efficiency** — background task pods no longer carry Chromium's CPU/RAM.
- **Improved security** — Chromium isolated in a hardened, containerized runtime (sandbox on,
  root dropped, seccomp, no shared mounts, strict egress network policy).
- **Patch velocity** — CVE fixes ship by updating one service image, *without* redeploying every
  Kibana. This is the big win for Hosted/ECH.
- **Future-proofing** — the DevTools automation is decoupled from Kibana versions.

**Shape of the service (Mike's sizing)**

- Lightweight API server routes each request to a free worker, returns `429` if none are free,
  and exposes a **status endpoint** so callers don't hold a connection open.
- ~200 reports/hour today (ECH + on-prem), ~30s each; ~800/hour at 4× spike. A 2GB worker does
  ~2 reports/min → ~**8×2GB workers** + 2×1GB API nodes. Est. **~\$200/month**.
- Deploy as a **K8s Deployment per cloud provider** with an **HPA**.

**Alternatives Mike considered and set aside**

| Alternative | Why set aside |
|---|---|
| Bump Serverless background nodes to 2GB | Fastest, but raises COGS and doesn't fix security |
| Dedicated reporting nodes in Serverless | Scales independently, but same CVE/patch problem |
| Reuse Synthetics | Unlikely to speed time-to-market; misaligned with purpose-built direction |

---

## Architecture (three tiers)

The POC models the topology Mike's doc describes: a lightweight API tier in front of a pool of
render workers, with artifacts persisted to Elasticsearch.

```
┌────────────┐   HTTP (Authorization: ApiKey)   ┌──────────────────┐   HTTP    ┌───────────────┐
│  Kibana    │ ───────────────────────────────► │  API / router    │ ────────► │  Worker(s)    │
│ (reporting │  serialized render request       │  tier            │  /render  │  own Chromium │
│  task)     │ ◄─────────────────────────────── │  • admission     │           │  + render     │
└────────────┘   artifact bytes (read from ES)  │    control (429) │           │    pipeline   │
                                                 │  • routes to     │           └──────┬────────┘
                                                 │    workers       │                  │ writes result
                                                 │  • /metrics      │                  ▼
                                                 │  • NO Chromium   │           ┌───────────────┐
                                                 └────────┬─────────┘           │ Elasticsearch │
                                                          └────── reads ───────►│  result index │
                                                             artifact           └───────────────┘
```

- **Tier 1 — Kibana:** unchanged reporting path; a config-gated client forwards the render request.
- **Tier 2 — API / router:** admission control (concurrency + bounded queue + `429`), routes each
  accepted render to the least-busy worker, exposes a `/metrics` gauge for autoscaling, and reads
  finished artifacts back from ES to serve downloads. **Runs no Chromium and holds no artifact bytes.**
- **Tier 3 — Worker:** owns Chromium + the render pipeline; writes the rendered artifact **straight
  to Elasticsearch** under the job id, then returns only metadata.
- **Elasticsearch:** the single result store (result-storage decision **A** — see [D6](#d6-result-storage-who-writes-to-es)).

---

## What this POC does

Reporting calls exactly one seam: `ScreenshottingStart.getScreenshots(options)` in
`x-pack/platform/plugins/shared/screenshotting/server/plugin.ts`. The `options` reporting passes
(`{ format, browserTimezone, layout, urls + locator context, request.headers, taskInstanceFields }`)
are **fully JSON-serializable** — which is exactly "all the information required to navigate and
capture" from Mike's doc.

The POC:

1. **Adds config** (`xpack.screenshotting.service.*`, defined in this package's
   `src/config/schema.ts`):
   ```yaml
   xpack.screenshotting.service.enabled: false      # default OFF → zero behavior change
   xpack.screenshotting.service.url: http://127.0.0.1:8790   # the API/router tier
   xpack.screenshotting.service.mode: async         # 'sync' | 'async'
   xpack.screenshotting.service.apiKey: <encoded>   # ES API key: auth + reused for ES read/write
   ```
2. **Config-gates the seam** in `screenshotting/server/plugin.ts`: when enabled, `getScreenshots`
   is backed by a new `ServiceScreenshotClient` (serializes options + auth headers → HTTP, sends
   the `apiKey` as `Authorization: ApiKey …`, adapts the returned bytes back into the exact
   `ScreenshotResult` reporting expects, surfaces `429` as a retryable error). When disabled, the
   original in-process Chromium path is used.
   **No change to reporting, Task Manager, `Screenshots`, or `HeadlessChromiumDriver`.**
3. **Ships a standalone service** under `x-pack/examples/reporting_service_poc/`, split into an
   **API/router process** (`scripts/start_service.js`) and a **worker process**
   (`scripts/start_worker.js`). The worker **reuses Kibana's own render pipeline**
   (`Screenshots` + `HeadlessChromiumDriverFactory`) so rendering fidelity is identical.
4. **Persists results to Elasticsearch** — the worker reuses the API key to write the artifact to
   an ES index; the router reads it back for downloads. **No artifact bytes ever live in service
   memory** (result-storage decision **A**).
5. **Exposes `/metrics`** on the router (active renders, queue depth, `429` count, per-worker
   in-flight) as the autoscaling signal (decision **1** — see [D10](#d10-autoscaling-signal)).

> ⚠️ **How the worker gets the render pipeline today:** it imports Kibana's plugin-internal
> modules directly (via `@kbn/setup-node-env`) from the same source tree. This is the single
> biggest "not production-ready" shortcut — see [decision D1](#d1-how-does-the-service-get-the-render-pipeline).

### HTTP API (v1)

**API / router tier** (what Kibana calls, base `http://127.0.0.1:8790`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/version` | API version |
| `GET` | `/api/v1/metrics` | Live gauge for autoscaling (active, queued, `429`s, workers) |
| `POST` | `/api/v1/screenshot` | **Sync** — blocks, returns artifact bytes (read from ES) |
| `POST` | `/api/v1/jobs` | **Async** — `202 {jobId}` |
| `GET` | `/api/v1/jobs/:id` | Poll status |
| `GET` | `/api/v1/jobs/:id/artifact` | Download bytes (read from ES) when `completed` |

**Worker tier** (called by the router, base `http://127.0.0.1:8791`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/metrics` | Per-worker active/total renders |
| `POST` | `/api/v1/render` | Render one request + write the artifact to ES |

Over capacity → `429 + Retry-After`; the Kibana client marks it retryable so Task Manager backs off.

---

## How to run the POC

Four terminals (ES, the API/router tier, a worker, and Kibana).

**Window 1 — Elasticsearch**

```bash
yarn es snapshot --license trial
```

**(Optional) create an ES API key** to exercise the `apiKey` path. Without it, the service falls
back to `elastic:changeme` basic auth so it still runs:

```bash
curl -s -u elastic:changeme -X POST http://localhost:9200/_security/api_key \
  -H 'Content-Type: application/json' -d '{"name":"reporting-poc"}' | jq -r .encoded
# → copy the encoded value into --xpack.screenshotting.service.apiKey below
```

**Window 2 — the API / router tier** (no Chromium)

```bash
node x-pack/examples/reporting_service_poc/scripts/start_service.js
# options: --port 8790  --worker-url http://127.0.0.1:8791  --es-url http://localhost:9200
#          --result-index reporting-service-poc-results  --concurrency 1  --queue-depth 10
```

Wait for `✓ Reporting API service listening on http://127.0.0.1:8790`.

**Window 3 — a render worker** (owns Chromium, writes results to ES)

```bash
node x-pack/examples/reporting_service_poc/scripts/start_worker.js
# options: --port 8791  --kibana-url http://localhost:5601  --es-url http://localhost:9200
#          --result-index reporting-service-poc-results
```

Wait for `✓ Reporting worker listening on http://127.0.0.1:8791`. (Run more workers on other ports
and pass them all to the router with `--worker-url a,b,c` — bump `--concurrency` to match.)

**Window 4 — Kibana with service mode ON**

```bash
yarn start --run-examples --no-base-path \
  --xpack.screenshotting.service.enabled=true \
  --xpack.screenshotting.service.url=http://127.0.0.1:8790 \
  --xpack.screenshotting.service.mode=async \
  --xpack.screenshotting.service.apiKey=<encoded-key>   # optional; omit to use basic-auth fallback
```

**Try it:** add the Flights sample data, open *[Flights] Global Flight Dashboard*,
Share → Export → PNG or PDF. Window 4 logs the outbound service call; Window 2 logs the dispatch to
the worker; Window 3 logs the Chromium render and the ES write. Watch the queue live with
`curl -s http://127.0.0.1:8790/api/v1/metrics | jq`. To prove the worker is doing the work, kill
Window 3 and regenerate (job fails with a connection error); restart it and it succeeds. Restart
Kibana **without** the `service.*` flags to confirm the in-process fallback still works.

A more detailed runbook + curl examples live in
`x-pack/examples/reporting_service_poc/README.md`.

---

## What works / what doesn't

### ✅ Works

- **PNG export** (preserve layout).
- **PDF export with "Optimize for printing" OFF** (preserve layout — screenshots assembled into a
  PDF by pdfmake on the Node side).
- **Three-tier topology** — Kibana → API/router → worker, with the router dispatching to the
  least-busy worker (run multiple workers and watch them balance).
- **ES-backed result storage** — the worker writes the artifact to Elasticsearch; the router reads
  it back for downloads. No artifact bytes in service memory.
- **API-key reuse** — Kibana's `apiKey` authenticates the service call and is reused by the worker
  to write the result to ES (with an `elastic:changeme` basic-auth fallback so it runs out of the box).
- **`/metrics` endpoint** — live gauge (active renders, queue depth, `429` count, per-worker in-flight).
- **Sync and async** interaction models.
- **`429` backpressure** → retryable error in Kibana.
- **Config gate / fallback** — with flags off, Kibana renders in-process exactly as today.

### ❌ Broken

- **PDF export with "Optimize for printing" ON** (print layout). It produces a PDF, but the pages
  are full of loading spinners and render errors instead of charts, and it takes much longer
  (~60s vs ~10s).

  **Root cause (understood, not yet fixed):** the print-PDF path is different from every other
  path. Instead of screenshotting each element and assembling a PDF, it calls Chromium's native
  `page.pdf()` on the whole page (`getPdf` → `driver.printA4Pdf`). The render-wait phase
  (`waitForVisualizations`) is timing out, and the pipeline's per-URL `catchError`
  (`screenshots.ts`) swallows the timeout and prints the page anyway with `error` set — so you get
  a PDF of a half-rendered page. Why the print layout specifically times out in the service
  harness (it stacks all panels into one very tall viewport and prints with print-media CSS) still
  needs investigation; it may be a harness/timeout/CSS difference rather than a fundamental blocker.
  Tracked as a known issue for this POC.

- **`diagnose()`** stays local (not routed to the service) — intentionally out of scope.

---

## Current browser lifecycle & isolation

**What happens today (measured from the worker logs):** each **worker** constructs **one**
`Screenshots` + one `HeadlessChromiumDriverFactory` at startup, but **each render request calls
`puppeteer.launch()` — a brand-new Chromium process** — opens a single page, captures, and then
**closes the entire browser** (`browser.close()` + deletes the temp user-data dir). It does **not**
reuse a long-lived browser and does **not** use incognito `BrowserContext`s. Within a worker,
renders are effectively serialized (the `Screenshots` semaphore is `poolSize: 1`). The router's
`--concurrency` gates how many renders are dispatched across the worker pool, so **keep
`--concurrency` ≈ (number of workers × per-worker capacity)** — with one `poolSize: 1` worker that
means `--concurrency 1`.

So today's model is the **most isolated but least efficient** end of the spectrum: full
process-per-request isolation, no reuse, cold-start Chromium every time. That's fine for a POC and
actually a decent security default, but it's not how a real multi-tenant service should run. The
isolation model is a real decision — see [D3](#d3-browser-isolation-model).

---

## Options to explore & decisions to make

Each option lists pros/cons and alternatives. None of these are decided.

### D1. How does the service get the render pipeline?

Today each **worker** `require()`s Kibana's plugin-internal modules from the same source tree. That
only works when built from a Kibana checkout — unacceptable for a service that ships and versions
independently. (This is the same coupling problem as the ES chunk-writer contract in [D6](#d6-result-storage-who-writes-to-es).)

- **Option A — Extract a `@kbn/screenshotting-render` package.** Move `Screenshots`,
  `HeadlessChromiumDriverFactory`, layouts, and the driver into a standalone, versioned package the
  service builds against.
  - *Pros:* real fidelity (same code), clean dependency, versioned with Kibana releases.
  - *Cons:* non-trivial extraction (core deps to sever), the service stays "Kibana-aware" and must
    track Kibana's Chromium/puppeteer versions.
  - *Alternative:* publish it to an internal registry vs. vendoring it into the service repo.
- **Option B — "Render recipe" protocol.** Kibana sends a declarative recipe (URL, auth headers,
  wait selectors, viewport, layout) and the service owns a generic render implementation.
  - *Pros:* truly decouples the service from Kibana internals; smallest coupling surface.
  - *Cons:* must re-implement and maintain fidelity (screenshot-mode, wait-for-render, header
    injection, print layout) separately; highest risk of drift/regressions.
- **Option C — Keep it Kibana-aware (embed the contract).** The service embeds the render contract
  and is released in lockstep with Kibana.
  - *Pros:* simplest API.
  - *Cons:* version-locks the service to Kibana; weakens the "patch Chromium independently" benefit.

### D2. Where does the service live — new repo or in Kibana?

- **Option A — New dedicated repo (recommended to explore).** e.g. `elastic/kibana-reporting-service`.
  - *Pros:* independent CI/CD and release cadence (the core point — patch Chromium without a Kibana
    release), smaller image, clear ownership, its own security scanning.
  - *Cons:* must solve render-pipeline sharing (see D1) across repos; cross-repo version
    coordination; new infra/on-call surface.
  - *Alternative:* a repo that consumes the extracted `@kbn/screenshotting-render` package.
- **Option B — Keep it in the Kibana monorepo** (e.g. a buildable package/app).
  - *Pros:* trivial code sharing (no extraction needed), one place to change.
  - *Cons:* couples release cadence to Kibana — directly undermines the CVE-patch-velocity goal;
    larger blast radius.
- **Option C — Separate deployable, code still in monorepo** (built + published from Kibana CI as
  its own image).
  - *Pros:* code sharing stays easy; deploys/patches somewhat independently.
  - *Cons:* still bound to Kibana's build/release timeline for image updates.

### D3. Browser isolation model

Today: new Chromium **process per request** (see above). Options, from most to least isolated:

- **Process per request (current).**
  - *Pros:* strongest isolation; no cross-request/tenant state; simple teardown.
  - *Cons:* cold-start cost every report; no warm reuse; highest CPU churn.
- **Per-tenant browser pool.** A warm `Browser` per tenant, lazily created, idle-timed-out, recycled.
  - *Pros:* good isolation boundary at the tenant level + warm reuse within a tenant.
  - *Cons:* memory grows with active tenants; needs eviction/recycling policy; a crash affects a
    tenant's in-flight jobs.
- **Shared browser, incognito `BrowserContext` per request/tenant.**
  - *Pros:* fast (one warm browser), contexts give cookie/storage separation.
  - *Cons:* context isolation is **weaker than process isolation** (shared browser process/GPU);
    needs a security sign-off for multi-tenant.
- **Shared browser + shared context.**
  - *Pros:* fastest, lowest memory.
  - *Cons:* unacceptable for multi-tenant (cross-tenant state/credential leakage risk).

> It's a legitimate option to **not** do per-tenant browsers at all and keep process-per-request
> (or a single shared pool) if the service is deployed **per project/namespace** so tenancy is
> enforced at the deployment boundary instead of inside the browser. That trades infra footprint
> for a much simpler, safer isolation story.

### D4. Authentication at the Kibana → service boundary

Today: Kibana sends the configured `apiKey` as `Authorization: ApiKey …` over **localhost HTTP (no
TLS)**; the router forwards it to the worker, which **reuses it to write the result to ES**, and the
router reuses it for ES reads. When unset, an `elastic:changeme` basic-auth fallback is used. So the
key is static/shared, in cleartext on the wire, and grants whatever ES privileges it was minted with
— all fine for a POC, none of it production-grade.

- **Option A — mTLS + service token.** *Pros:* strong, standard for service-to-service. *Cons:* cert
  management/rotation.
- **Option B — Short-lived bearer token per request.** *Pros:* simple; bounded lifetime. *Cons:*
  needs an issuer/broker; clock/rotation concerns.
- **Option C — Credential broker.** Service fetches per-job credentials from a broker instead of
  receiving them inline. *Pros:* raw credentials never sit on the service tier. *Cons:* most moving
  parts.
  - *Alternative on credential lifecycle:* late-mint the per-job API key at dispatch with a short
    expiry and invalidate on completion, independent of which transport is chosen.

### D5. Sync vs async interaction

The POC implements both. *Sync* is simplest and slots right behind the Observable seam but holds a
connection for the whole render. *Async* (submit → poll → download) matches Mike's "status endpoint
so the connection isn't held open" and is friendlier to long renders and autoscaling, at the cost of
poll latency and the router's in-memory **job-status** registry (see D6).

### D6. Result storage: who writes to ES

**Decided: Option A — the worker writes the artifact directly to Elasticsearch.** ES is the only
approved store (no object store, no broker), so the only open question was *who* writes it, and the
constraints ("ES-only" + "no worker memory" + async) force the worker to write ES directly: with
async there is nowhere else to park bytes between render-complete and download.

**What the POC does:** the worker renders, then writes the artifact (base64 in a `binary`-typed
field) to `reporting-service-poc-results` keyed by job id, reusing the request's API key; the router
reads it back to serve downloads. No artifact bytes ever sit in service memory.

Considered and set aside:
- **B — worker streams bytes back; Kibana writes ES.** Keeps the worker stateless (no ES creds), but
  can't do async without a parking spot → collapses back into A under the ES-only/no-memory rule.
  Still attractive for a pure-sync, zero-ES-privilege worker.
- **C — worker writes a temp ES location; Kibana finalizes.** A security boundary if the worker must
  not hold final-index creds, but doubles the write + adds a move step.

**Still to do to make A production-grade:**
- **Reuse Kibana's chunk-writer contract.** Real Reporting chunks content into ~1 MB docs
  (`reporting/server/lib/content_stream.ts`); the POC stores a single doc. Extract that writer into a
  versioned package the worker shares (same coupling pattern as [D1](#d1-how-does-the-service-get-the-render-pipeline))
  and write to the **real reporting data stream** so downloads flow through Kibana's existing path.
- **Scoped, short-lived, per-job ES credentials** so a worker can only write the intended tenant's
  index (ties into [D4](#d4-authentication-at-the-kibana--service-boundary)).
- **Lifecycle ownership** — Kibana still owns the report record/status; define whether the worker
  writes only content or also flips status, and make writes idempotent on `jobId` for crash retries.
- **Durable job status** — the router's job-status registry is still in-memory (lost on restart) and
  per-process (an async job submitted via one router replica can't be polled from another). Options:
  derive status from the report record in ES, or use Task Manager as the source of truth.

### D7. Failure behavior when the service is unreachable

- **Fail closed** (current-ish): the job fails clearly. *Pros:* preserves the isolation guarantee.
  *Cons:* reports break during a service outage.
- **Fall back to in-process Chromium.** *Pros:* resilience. *Cons:* re-introduces Chromium into
  Kibana pods (defeats the purpose) and hides outages. Likely acceptable only on Hosted/ECH, never
  Serverless.

### D8. Deployment & multi-tenancy enforcement

Per Mike: K8s Deployment per cloud provider + HPA (scale on queue depth / active sessions / CPU).
Open: one shared multi-tenant fleet vs. per-project/namespace deployment; how HPA signals are
sourced; air-gapped/on-prem packaging; and "restrict reporting when not running in the supported
containerized environment."

### D9. Router / queue tier & backpressure ownership

**Partially built:** the POC has a dedicated API/router tier that owns admission control and routes
to a worker pool over HTTP. This is deliberately **no-broker** (constraint): the router keeps an
in-process bounded queue + semaphore and returns `429` at capacity; Task Manager (in Kibana) remains
the durable backlog.

Open sub-decisions:
- **Durable vs. in-process queue.** The router's queue and job-status registry are in-memory today
  (fine for one replica; a restart drops in-flight status). Since brokers are off the table, the
  durable backlog has to stay in **Task Manager**, with the router as a transient smoothing buffer.
- **Multiple router replicas.** More than one router means admission control and the `/metrics`
  gauge are per-replica; you'd need to aggregate (or front them so each worker pool has one router).
- **Router ↔ worker protocol.** Today it's synchronous HTTP push (router holds the dispatch open
  until the worker finishes + writes ES). A pull model would need shared state we're avoiding.

### D10. Autoscaling signal

**Decided: Option 1 — scale on the service's own live gauge.** The router exposes
`GET /api/v1/metrics` (active renders, queued, `429` count, per-worker in-flight); an HPA/KEDA
`metrics-api` scaler polls it. Nothing is persisted and no broker is needed — it's pure runtime
state, which satisfies "only ES stores data."

Open / to layer on later:
- **Add a *demand* signal** (the gauge above is *saturation* — workers already busy). Two no-broker
  sources: (a) reuse Task Manager's existing periodic **workload aggregation** via
  `/api/task_manager/_health` (or `/api/task_manager/metrics`) — TM already counts tasks by
  type/status every `monitored_aggregated_stats_refresh_rate` (default **60s**, min **5s**), so no
  extra query load; or (b) a cheap filtered `_count` of in-flight report records in the reporting
  index (data we own; a filtered count is cheap regardless of index size). Scale on `max(saturation,
  demand)`.
- **Avoid** pointing an autoscaler at heavy ad-hoc queries against the raw `.kibana_task_manager`
  index — TM already aggregates, and a filtered `_count` is cheap.
- CPU/memory HPA is a laggy backstop only.

---

## What we did NOT do

- **Print-layout PDF** — broken (see above).
- **Render-pipeline packaging** — the worker imports Kibana internals instead of a versioned
  package (D1).
- **Real reporting-store integration** — the worker writes a **single** doc to a POC index rather
  than reusing Kibana's chunked `content_stream` writer into the real reporting data stream (D6).
- **TLS + hardened auth** — the API key is static/shared and travels over localhost HTTP without
  TLS; no per-job/short-lived/invalidate-on-complete keys; no egress allowlist.
- **True multi-tenant isolation** — single shared render pipeline, process-per-request, no
  per-tenant pools/contexts, no tenant tagging on logs/metrics/artifacts/keys.
- **Serverless UIAM key strategy** validation for the remote handoff.
- **Durable job status** — the router's job-status registry is in-memory (lost on restart) and
  per-replica; only the *artifacts* are durable (in ES).
- **Demand-based autoscaling** — only the router's saturation gauge exists; the Task-Manager/report
  `_count` demand signal (D10) is documented, not wired.
- **Containerization / K8s / HPA / per-provider deployment.**
- **Observability** — a live `/metrics` gauge exists, but no historical metrics, durations, or tracing.
- **Tests** — no unit/integration/security/load tests for the client, router, worker, or queue.
- **`diagnose()`** routing to the service.
- **Concurrency reconciliation** — keep the router's `--concurrency` ≈ (workers × per-worker
  capacity); each worker's `Screenshots` semaphore is `poolSize: 1`.

## Open decisions

Quick index of the calls the team needs to make (details above):

1. **D1** — how the service gets the render pipeline (extract package / render recipe / Kibana-aware).
2. **D2** — new repo vs. in-monorepo for the service.
3. **D3** — browser isolation model (process-per-request / per-tenant pool / incognito context /
   deployment-per-tenant).
4. **D4** — auth at the boundary + per-job credential lifecycle.
5. **D5** — sync vs. async (or both) as the supported contract.
6. **D6** — result storage in ES: *decided — worker writes ES directly (A)*; remaining work is the
   chunk-writer contract, scoped creds, and durable job status.
7. **D7** — failure behavior (fail closed vs. local fallback, per environment).
8. **D8** — deployment topology & where multi-tenancy is enforced.
9. **D9** — router/queue tier ownership (durable-queue-in-Task-Manager, replica aggregation).
10. **D10** — autoscaling signal: *decided — router `/metrics` saturation gauge (1)*; still to add a
    Task-Manager/report `_count` demand signal.

### Other things worth deciding / adding

- **API versioning & compatibility policy** across Kibana N / N-1 (Mike requires a versioned API).
- **Chromium version pinning** policy between the service and the Kibana versions it renders for.
- **Render fidelity verification** — compare service output vs. in-process output byte-for-byte
  across layouts as a regression gate.
- **Backpressure tuning** — how `429`/`Retry-After` interacts with Task Manager's backoff under real
  load.
- **Cost/COGS validation** against Mike's ~\$200/month estimate as adoption grows.
