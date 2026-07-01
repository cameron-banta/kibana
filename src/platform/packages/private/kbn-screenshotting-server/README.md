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
of launching Chromium in-process.

## Contents

- [Background: Mike Cote's proposal](#background-mike-cotes-proposal)
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
   xpack.screenshotting.service.url: http://127.0.0.1:8790
   xpack.screenshotting.service.mode: async         # 'sync' | 'async'
   ```
2. **Config-gates the seam** in `screenshotting/server/plugin.ts`: when enabled, `getScreenshots`
   is backed by a new `ServiceScreenshotClient` (serializes options + auth headers → HTTP,
   adapts the returned bytes back into the exact `ScreenshotResult` reporting expects, surfaces
   `429` as a retryable error). When disabled, the original in-process Chromium path is used.
   **No change to reporting, Task Manager, `Screenshots`, or `HeadlessChromiumDriver`.**
3. **Ships a standalone service** under `x-pack/examples/reporting_service_poc/` that **reuses
   Kibana's own render pipeline** (`Screenshots` + `HeadlessChromiumDriverFactory`) so rendering
   fidelity is identical, with a semaphore + bounded queue + `429`, plus sync and async
   (submit / poll / download) endpoints, and health/version routes.

> ⚠️ **How the service gets the render pipeline today:** it imports Kibana's plugin-internal
> modules directly (via `@kbn/setup-node-env`) from the same source tree. This is the single
> biggest "not production-ready" shortcut — see [decision D1](#d1-how-does-the-service-get-the-render-pipeline).

### HTTP API (v1)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/version` | API version |
| `POST` | `/api/v1/screenshot` | **Sync** — blocks, returns artifact bytes |
| `POST` | `/api/v1/jobs` | **Async** — `202 {jobId}` |
| `GET` | `/api/v1/jobs/:id` | Poll status |
| `GET` | `/api/v1/jobs/:id/artifact` | Download bytes when `completed` |

Over capacity → `429 + Retry-After`; the Kibana client marks it retryable so Task Manager backs off.

---

## How to run the POC

Three terminals.

**Window 1 — Elasticsearch**

```bash
yarn es snapshot --license trial
```

**Window 2 — the reporting service** (owns Chromium)

```bash
node x-pack/examples/reporting_service_poc/scripts/start_service.js
# options: --port 8790  --kibana-url http://localhost:5601  --concurrency 2  --queue-depth 10
```

Wait for `✓ Reporting service listening on http://127.0.0.1:8790`.

**Window 3 — Kibana with service mode ON**

```bash
yarn start --run-examples --no-base-path \
  --xpack.screenshotting.service.enabled=true \
  --xpack.screenshotting.service.url=http://127.0.0.1:8790 \
  --xpack.screenshotting.service.mode=async
```

**Try it:** add the Flights sample data, open *[Flights] Global Flight Dashboard*,
Share → Export → PNG or PDF. Window 3 logs the outbound service call; Window 2 logs the Chromium
render. To prove the service is doing the work, kill Window 2 and regenerate (job fails with a
connection error); restart it and it succeeds. Restart Kibana **without** the `service.*` flags to
confirm the in-process fallback still works.

A more detailed runbook + curl examples live in
`x-pack/examples/reporting_service_poc/README.md`.

---

## What works / what doesn't

### ✅ Works

- **PNG export** (preserve layout).
- **PDF export with "Optimize for printing" OFF** (preserve layout — screenshots assembled into a
  PDF by pdfmake on the Node side).
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

**What happens today (measured from the service logs):** the service constructs **one**
`Screenshots` + one `HeadlessChromiumDriverFactory` at startup, but **each render request calls
`puppeteer.launch()` — a brand-new Chromium process** — opens a single page, captures, and then
**closes the entire browser** (`browser.close()` + deletes the temp user-data dir). It does **not**
reuse a long-lived browser and does **not** use incognito `BrowserContext`s. Requests are
effectively serialized (the `Screenshots` semaphore is `poolSize: 1`, even though the service queue
default `--concurrency` is 2 — a mismatch worth fixing).

So today's model is the **most isolated but least efficient** end of the spectrum: full
process-per-request isolation, no reuse, cold-start Chromium every time. That's fine for a POC and
actually a decent security default, but it's not how a real multi-tenant service should run. The
isolation model is a real decision — see [D3](#d3-browser-isolation-model).

---

## Options to explore & decisions to make

Each option lists pros/cons and alternatives. None of these are decided.

### D1. How does the service get the render pipeline?

Today the service `require()`s Kibana's plugin-internal modules from the same source tree. That
only works when built from a Kibana checkout — unacceptable for a service that ships and versions
independently.

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

Today: unauthenticated localhost HTTP; auth headers (API key) travel in the request body in plaintext.

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
poll latency and an in-memory job store (see D6).

### D6. Result delivery

Today: bytes returned inline (sync) or held in an in-memory job store (async, lost on restart).

- **Option A — Object store (S3/GCS) + return a reference.** *Pros:* scales to large PDFs, survives
  restarts, decouples download. *Cons:* new dependency + lifecycle/cleanup.
- **Option B — Stream bytes back.** *Pros:* simplest. *Cons:* ties up connections; awkward for very
  large artifacts.

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

---

## What we did NOT do

- **Print-layout PDF** — broken (see above).
- **Render-pipeline packaging** — the service imports Kibana internals instead of a versioned
  package (D1).
- **Security** — no mTLS/auth at the service; auth headers in plaintext over localhost; no
  credential hardening (short-lived/invalidate-on-complete keys); no egress allowlist.
- **True multi-tenant isolation** — single shared render pipeline, process-per-request, no
  per-tenant pools/contexts, no tenant tagging on logs/metrics/artifacts/keys.
- **Serverless UIAM key strategy** validation for the remote handoff.
- **Result durability** — async jobs are in-memory (lost on restart); no object store.
- **Containerization / K8s / HPA / per-provider deployment.**
- **Observability** — console logging only; no metrics (queue depth, active renders, 429 rate,
  durations), no tracing.
- **Tests** — no unit/integration/security/load tests for the client, queue, or service.
- **`diagnose()`** routing to the service.
- **Concurrency reconciliation** — the service queue's `--concurrency` (2) exceeds the
  `Screenshots` semaphore (`poolSize: 1`), so effective concurrency is 1.

## Open decisions

Quick index of the calls the team needs to make (details above):

1. **D1** — how the service gets the render pipeline (extract package / render recipe / Kibana-aware).
2. **D2** — new repo vs. in-monorepo for the service.
3. **D3** — browser isolation model (process-per-request / per-tenant pool / incognito context /
   deployment-per-tenant).
4. **D4** — auth at the boundary + per-job credential lifecycle.
5. **D5** — sync vs. async (or both) as the supported contract.
6. **D6** — result delivery (object store vs. inline).
7. **D7** — failure behavior (fail closed vs. local fallback, per environment).
8. **D8** — deployment topology & where multi-tenancy is enforced.

### Other things worth deciding / adding

- **API versioning & compatibility policy** across Kibana N / N-1 (Mike requires a versioned API).
- **Chromium version pinning** policy between the service and the Kibana versions it renders for.
- **Render fidelity verification** — compare service output vs. in-process output byte-for-byte
  across layouts as a regression gate.
- **Backpressure tuning** — how `429`/`Retry-After` interacts with Task Manager's backoff under real
  load.
- **Cost/COGS validation** against Mike's ~\$200/month estimate as adoption grows.
