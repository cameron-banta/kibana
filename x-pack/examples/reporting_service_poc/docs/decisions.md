# Reporting Service POC — Options, decisions & open questions

> Part of the multi-tenant reporting service POC. See also:
> [Mike's proposal](./proposal.md) · [Architecture & behavior](./architecture.md) ·
> [Runbook](../README.md).

## Options to explore & decisions to make

Each option lists pros/cons and alternatives. Items marked **Decided** reflect calls already made
for this POC; the rest are open.

### D1. How does the service get the render pipeline?

Today each **worker** `require()`s Kibana's plugin-internal modules from the same source tree. That
only works when built from a Kibana checkout — unacceptable for a service that ships and versions
independently. (This is the same coupling problem as the ES chunk-writer contract in
[D6](#d6-result-storage-who-writes-to-es).)

- **Option A — Extract a `@kbn/screenshotting-render` package.** Move `Screenshots`,
  `HeadlessChromiumDriverFactory`, layouts, and the driver into a standalone, versioned package the
  service builds against.
  - *Pros:* real fidelity (same code), clean dependency, versioned with Kibana releases.
  - *Cons:* non-trivial extraction (core deps to sever), the service stays "Kibana-aware" and must
    track Kibana's Chromium/puppeteer versions.
  - *Alternative:* publish it to an internal registry vs. vendoring it into the service repo.
- **Option B — "Render recipe" / generic render service.** Kibana sends (or serves) a declarative
  recipe and the service owns a small, **generic render vocabulary with no Kibana-specific terms**.
  See the [Kibana logic embedded in the worker today](./architecture.md#kibana-logic-embedded-in-the-worker-today)
  table for exactly what this option has to relocate. Prior art for a generic "URL → PDF/PNG"
  microservice: [browserless.io](https://www.browserless.io) (`/pdf`, `/screenshot`,
  `waitForSelector`, `waitForFunction`, `addStyleTag`, `setExtraHTTPHeaders`, `cookies`) and
  [Gotenberg](https://gotenberg.dev) (`waitForExpression`, `waitDelay`).
  - **The generic vocabulary** (what the service understands — Puppeteer primitives, no Kibana words):
    `url`(s), `viewport`, `headers`/`cookies`, `initScripts[]` (opaque JS — screenshot-mode lives
    here), `styles[]` (opaque CSS — layout/print CSS lives here), `waitFor`
    (`selector` | `functionBody` | `networkIdle` | `delayMs`), and `output` (`png` full-page/clips,
    or `pdf`). Everything Kibana-specific becomes **data** in those fields; the service just runs
    `addInitScript` / `addStyleTag` / `waitForFunction` / `screenshot` / `pdf`.
  - **Two ways to deliver the recipe:**
    - *Recipe-by-reference* — Kibana mints a short-lived **signed URL** that returns the recipe JSON;
      the service `GET`s it and executes generic steps. Contract lives 100% in Kibana, tiny wire
      payload, auditable, can carry auth/expiry. Service knowledge of Kibana = "dereference a recipe."
    - *Fat self-contained page* — Kibana's app renders the **whole** report at one URL, applies its
      own print CSS, and exposes a **generic ready signal** (e.g. `<body data-report-ready="true">`).
      The service only does `goto` + `waitForSelector` + capture. Pushes layout **and**
      completion-detection into Kibana's page (where the render smarts arguably belong).
  - **PDF assembly is the crux** — keep zero layout smarts in the service via either: (a) *native
    print-to-PDF* (`page.pdf()`), which depends on Kibana's page being print-ready — note this is
    the [currently-broken print path](./architecture.md#what-works--what-doesnt); or (b) *PNG-only
    service + Kibana assembles the PDF* (Kibana already has pdfmake), so the service never emits PDFs.
  - *Pros:* truly decouples the service from Kibana internals — smallest coupling surface (only an
    origin + creds in config); independently versioned/deployable → the CVE-patch-velocity win;
    reusable by non-Kibana callers; bounded security review.
  - *Cons:* must re-implement and maintain fidelity separately. The **ready-signal contract becomes
    the critical thing** — a page that reports "ready" too early reproduces today's half-rendered
    print bug; leans on fixing the print path (or going PNG-only); the service blindly runs
    Kibana-supplied JS/CSS → needs signed-recipe + trusted-origin + egress allowlist; loses Option
    A's "same code = same output" guarantee; the Chromium/Puppeteer version still has to match the
    app's CSS/JS needs (looser coupling than importing code, but not zero).
  - **Leaning (from design discussion):** deliver a **small inline recipe** in the REST request body
    **plus a fat page URL** — drop *recipe-by-reference* (the recipe is small enough to inline; the
    heavy content lives behind the fat URL). **Support both PDF strategies** via the `output` enum and
    let the caller pick: native print-to-PDF for print layout, PNG(s) + Kibana-side pdfmake assembly
    for preserve layout. Choosing this path (and reusing the synthetics Chromium image → Playwright,
    see [D12](#d12-chromium-image--cve-patch-velocity)) **forecloses Option A** (no reuse of Kibana's
    Puppeteer pipeline).
  - *Remaining sub-decision:* how the ready signal is defined and verified — a render-parity
    regression gate (see [Other things worth deciding](#other-things-worth-deciding--adding)).
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

Today: new Chromium **process per request** (see
[browser lifecycle](./architecture.md#current-browser-lifecycle--isolation)). Options, from most to
least isolated:

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

**Decided for the current POC: Option A — the worker writes the artifact directly to Elasticsearch**
(the productionization now leans to the **callback model** below). ES is the only approved store (no
object store, no broker), so the only open question was *who* writes it, and the constraints
("ES-only" + "no worker memory" + async) force the worker to write ES directly: with async there is
nowhere else to park bytes between render-complete and download.

**What the POC does:** the worker renders, then writes the artifact (base64 in a `binary`-typed
field) to `reporting-service-poc-results` keyed by job id, reusing the request's API key; the router
reads it back to serve downloads. No artifact bytes ever sit in service memory.

**Design direction (post-POC): async result callback — supersedes worker-writes-ES.** The "who
writes ES" question only forced Option A because *async had nowhere to park bytes*. A **callback
URL** removes that constraint: on completion the worker POSTs the artifact (streamed) to a
Kibana-supplied `callbackUrl` + short-lived token, and **Kibana** writes it to ES via its existing
chunked `content_stream` writer. This:
- makes the worker **stateless** — no ES credentials, no result-index knowledge, no chunk-writer to
  extract (erases that D1-style coupling);
- unblocks the previously-rejected **Option B** for async (the callback *is* the parking spot);
- keeps **Kibana the owner** of storage + status (report record in ES), which also fixes the
  multi-replica/durable-status wart — the router leaves the result path entirely;
- generalizes to **non-Kibana consumers** (each caller supplies its own callback) — ES-write would
  not (see [D14](#d14-multi-consumer--reusability)).

Sync mode doesn't need this — it returns bytes in the HTTP response; the callback is the async story.
See [D7](#d7-failure-behavior--result-delivery) for the callback failure/retry model.

Considered and set aside (relative to the POC's Option A):
- **B — worker streams bytes back; Kibana writes ES.** Keeps the worker stateless (no ES creds), but
  can't do async without a parking spot → collapses back into A under the ES-only/no-memory rule.
  Still attractive for a pure-sync, zero-ES-privilege worker.
- **C — worker writes a temp ES location; Kibana finalizes.** A security boundary if the worker must
  not hold final-index creds, but doubles the write + adds a move step.

**Still to do to make A production-grade:**
- **Reuse Kibana's chunk-writer contract.** Real Reporting chunks content into ~1 MB docs
  (`reporting/server/lib/content_stream.ts`); the POC stores a single doc. Extract that writer into a
  versioned package the worker shares (same coupling pattern as
  [D1](#d1-how-does-the-service-get-the-render-pipeline)) and write to the **real reporting data
  stream** so downloads flow through Kibana's existing path.
- **Scoped, short-lived, per-job ES credentials** so a worker can only write the intended tenant's
  index (ties into [D4](#d4-authentication-at-the-kibana--service-boundary)).
- **Lifecycle ownership** — Kibana still owns the report record/status; define whether the worker
  writes only content or also flips status, and make writes idempotent on `jobId` for crash retries.
- **Durable job status** — the router's job-status registry is still in-memory (lost on restart) and
  per-process (an async job submitted via one router replica can't be polled from another). Options:
  derive status from the report record in ES, or use Task Manager as the source of truth.

### D7. Failure behavior & result delivery

Two related questions: what happens when the **service is unreachable at dispatch**, and how the
async **result callback** ([D6](#d6-result-storage-who-writes-to-es)) behaves when *it* fails.

**Service unreachable at dispatch:**
- **Fail closed** (recommended): the job fails clearly and Task Manager retries later. *Pros:*
  preserves the isolation guarantee. *Cons:* reports break during a service outage.
- **Fall back to in-process Chromium.** *Pros:* resilience. *Cons:* re-introduces Chromium into
  Kibana pods (defeats the purpose) and hides outages. Likely acceptable only on Hosted/ECH, never
  Serverless.

**Result-callback failure model** — there are **two distinct failure classes**:
- **Render failed, service alive** → the callback carries a **terminal outcome**, not just bytes:
  `{ jobId, status: "completed", <artifact> }` or `{ jobId, status: "failed", error }`. Kibana learns
  of failure by push; no polling needed.
- **Callback undeliverable (Kibana unreachable)** → push is impossible by definition. The worker
  **retries with backoff**, holding the artifact and **going busy** (refusing new work) meanwhile;
  after a **small** retry budget it **drops** the artifact and fails the job. Because the push channel
  is down, Kibana learns via a **Task Manager deadline** — no terminal callback within the deadline ⇒
  TM fails/retries the whole render. (Active polling is rejected: it re-introduces a queryable status
  store in the service and can't help when the network to Kibana is down anyway.)

**Load-shaping notes:**
- Attempt the callback **immediately**; only enter the hold+busy+retry state on failure, so the
  worker sits on bytes only in the degraded case.
- Keep the worker retry budget **small** — a parked worker is lost fleet capacity; **Task Manager is
  the durable retry layer**.
- The callback endpoint must be **idempotent on `jobId`** — a lost ack causes a retry that
  double-delivers; Kibana upserts and ignores duplicates.
- *Scaling escape hatch:* spill the artifact to ephemeral local disk + background-drain instead of
  holding in memory, so the worker keeps accepting work (reintroduces a little local state).

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

### D11. Implementation language / runtime

The language choice is **downstream of D1**: a Go worker is only viable under **Option B** (a Go
process can't run Kibana's TypeScript render pipeline, so Option A ⇒ Node).

- **Control plane (router / dispatch) in Go.** No Kibana coupling, no Chromium — pure HTTP +
  concurrency. Matches Elastic's Go-first production tooling; small static binary. *Strong, low-risk.*
- **Renderer/worker language** — two coherent bundles:
  - **Node + Puppeteer** — reuse Kibana's render pipeline (Option A) → best fidelity, but stays
    Kibana-aware and Puppeteer-pinned.
  - **Go or Node driving Chromium via CDP under Option B** — `chromedp`/`go-rod` (Go) or Puppeteer /
    Playwright (Node). Fidelity then rides entirely on the ready-signal contract.
- *Prior art:* **synthetics-service** is a **Go control plane** that orchestrates a **separate
  Node/Playwright/Chromium runner image** — it validates "Go orchestration + separate browser image,"
  **not** "Go drives Chromium." It has **zero** Go browser-driver deps.
- *Gotcha:* two-language contract (TS caller + Go/other service) ⇒ maintain the API via a shared
  schema (OpenAPI / JSON Schema) that generates both sides.
- *Staging:* router in Go now (safe); keep/port the worker later once Option B + parity tests hold.

### D12. Chromium image & CVE patch velocity

The whole point (Mike's proposal) is patching Chromium **without a Kibana release**. The key
realization from synthetics-service: **patch velocity comes from packaging + version automation, not
from the worker's language.**

- Ship the renderer as its own **independently-versioned container image**; patch = rebuild image +
  bump the version pointer + GitOps rollout, decoupled from the control-plane release.
- *Prior art (synthetics-service):* Chromium ships inside the `docker.elastic.co/beats/heartbeat`
  image; **`updatecli`** (`.github/workflows/bump-heartbeat-snapshot.yml`) auto-opens PRs bumping
  `heartbeatVersion` per environment overlay, rolled out via GitOps. Reuse this **pattern** (and
  ideally the same Chromium supply chain).
- **Reusing synthetics' Chromium ⇒ Playwright.** That image's Chromium is Playwright's bundled,
  patched build; Playwright expects its own browser, so adopting it means **Playwright as the driver**
  → which requires **D1 Option B** (Kibana's pipeline is Puppeteer-based). The alternative — keep
  Puppeteer + Kibana's own Chromium build (Option A) and apply the *same updatecli bump pattern* to it
  — gets the same velocity without literally sharing the image.
- *Not reusable from synthetics:* the **Go execution-controller / pod-provisioning** (client-go
  operator, ephemeral **Job-per-run**) — it's K8s-coupled and a different model from our long-lived
  warm workers. Reuse its **kustomize overlays + image-prepuller** patterns, not the operator.

### D13. Deployment packaging — standalone *and* Kubernetes/Serverless

Requirement: the same service must run **standalone** (local / `docker run`) **and** in
**K8s / Elastic Serverless**.

- Package the renderer as **one self-contained container image** (HTTP server + Chromium). Standalone
  = run the image directly; K8s = the **same image** as a `Deployment` + **HPA/KEDA** (see
  [D10](#d10-autoscaling-signal)).
- This is another reason **not** to reuse synthetics' Go operator: it's inherently K8s-coupled and
  can't run standalone. A plain containerized HTTP service satisfies both modes with one artifact.
- *Clarify:* "Serverless" here is assumed to mean **Elastic Serverless (on K8s)** — the Deployment +
  HPA path. True FaaS (Lambda-style) is painful for heavyweight Chromium (memory + cold start).
- Reuse synthetics' **image-prepuller** pattern to pre-cache the large Chromium image on nodes for
  fast start.

### D14. Multi-consumer / reusability

Goal: other services (not just Kibana Reporting) could use the render service later. Reusability is a
**free consequence of D1 Option B + the D6 callback** — a service with no Kibana knowledge is one any
caller can use. Keep the seams clean now; defer shared-fleet machinery.

- **Now (cheap — discipline):** neutral vocabulary (`render` / `job` / `artifact` / `callback`, never
  `report` / `dashboard`); all consumer specifics as **opaque data** (`initScripts` / `styles` /
  `waitFor` / `headers`); generic **bearer/token** auth (not Kibana's ES ApiKey); each caller owns its
  **fat page + ready signal** and its **callback**; a **versioned** contract.
- **Later (only when a 2nd consumer is real):** per-consumer auth + quotas + concurrency fairness;
  per-consumer **egress allowlist** (SSRF containment); consumer-tagged observability; tenant/consumer
  isolation (or sidestep via **per-consumer deployment** — same image, separate instance, tenancy at
  the deployment boundary).
- *Reality check on synthetics:* it runs **multi-step Playwright journeys** (assertions, per-step
  timings/availability), not "URL → PDF/PNG." Our render API won't replace that. The realistic shared
  surface is the **Chromium base image + CVE-bump pipeline**
  ([D12](#d12-chromium-image--cve-patch-velocity)), not this API. Design generically, but don't
  over-fit to synthetics as an API consumer.

---

## What we did NOT do

- **Print-layout PDF** — broken (see
  [what works / what doesn't](./architecture.md#what-works--what-doesnt)).
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
- **Design-only (not built in the POC):** the async **result callback** (D6/D7), **Go control plane +
  containerized Chromium image** (D11/D12), **standalone + K8s packaging** (D13), and **multi-consumer
  controls** (D14). The POC still does worker-writes-ES, Node/Puppeteer, in-process.

## Open decisions

Quick index of the calls the team needs to make (details above):

1. **D1** — how the service gets the render pipeline (extract package / render recipe / Kibana-aware).
2. **D2** — new repo vs. in-monorepo for the service.
3. **D3** — browser isolation model (process-per-request / per-tenant pool / incognito context /
   deployment-per-tenant).
4. **D4** — auth at the boundary + per-job credential lifecycle.
5. **D5** — sync vs. async (or both) as the supported contract.
6. **D6** — result storage in ES: *POC does worker-writes-ES (A)*; design leans to the async
   **callback** model (worker POSTs result to Kibana → removes ES/chunk-writer coupling).
7. **D7** — failure behavior + result-delivery/callback retry model (fail-closed + Task Manager
   deadline; small worker retry budget; idempotent callbacks).
8. **D8** — deployment topology & where multi-tenancy is enforced.
9. **D9** — router/queue tier ownership (durable-queue-in-Task-Manager, replica aggregation).
10. **D10** — autoscaling signal: *decided — router `/metrics` saturation gauge (1)*; still to add a
    Task-Manager/report `_count` demand signal.
11. **D11** — implementation language/runtime (Go control plane; renderer Node/Puppeteer or Option-B
    CDP). Go worker ⇒ Option B.
12. **D12** — Chromium image & CVE patch velocity (independently-versioned image + updatecli/GitOps;
    synthetics prior art; reusing synthetics' Chromium ⇒ Playwright ⇒ Option B).
13. **D13** — deployment packaging (one image runs standalone + K8s/Serverless; Deployment+HPA, not
    job-per-run).
14. **D14** — multi-consumer/reusability (neutral API + callback now; shared-fleet controls later).

### Other things worth deciding / adding

- **API versioning & compatibility policy** across Kibana N / N-1 (Mike requires a versioned API).
- **Chromium version pinning** policy between the service and the Kibana versions it renders for.
- **Render fidelity verification** — compare service output vs. in-process output byte-for-byte
  across layouts as a regression gate.
- **Backpressure tuning** — how `429`/`Retry-After` interacts with Task Manager's backoff under real
  load.
- **Cost/COGS validation** against Mike's ~\$200/month estimate as adoption grows.
