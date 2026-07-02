# Multi-tenant Reporting Service POC

Proof-of-concept for Mike Cote's multi-tenant reporting service proposal.

> **📖 Design docs** (this file is the practical runbook; the design writeup lives in [`./docs`](./docs)):
> - [Mike's proposal](./docs/proposal.md) — background, problems, benefits, sizing, alternatives
> - [Architecture & behavior](./docs/architecture.md) — three-tier design, HTTP API, what works / what doesn't, browser lifecycle
> - [Options, decisions & open questions](./docs/decisions.md) — the D1–D10 ledger

**Core thesis:** Instead of spawning Chromium inside Kibana, Kibana sends an HTTP request to a
standalone service. The service owns Chromium and the full render pipeline, renders the report, and
persists the artifact to Elasticsearch. Kibana's CPU/RAM is no longer affected by rendering.

This POC models a **three-tier topology**:

```
Kibana ──HTTP(ApiKey)──► API / router tier ──HTTP──► worker(s) ──write──► Elasticsearch
         (reporting)      (queue + 429 +              (Chromium +          (result index)
                           routing + /metrics)         render pipeline)         ▲
                                    └──────────────── read artifact ───────────┘
```

This is a **local-only proof of concept** intended for sharing on a private branch so the team can
run it and ask questions. It is not intended for merge to `main`.

---

## What this proves

1. **The decoupling works end-to-end.** Kibana generates a real PNG or PDF report by calling an
   external service that owns Chromium — with no change to reporting, Task Manager, or any export type.
2. **A three-tier split.** A lightweight API/router tier (no Chromium) does admission control and
   routes to render workers; run multiple workers and watch the router balance across them.
3. **ES-backed result storage.** The worker writes the artifact straight to Elasticsearch (reusing
   the API key); the router reads it back for downloads. No artifact bytes live in service memory.
4. **API-key reuse.** The `apiKey` Kibana uses to call the service is reused by the worker to write
   to ES (with an `elastic:changeme` basic-auth fallback so it runs out of the box).
5. **Autoscaling signal.** The router exposes `GET /api/v1/metrics` (active renders, queue depth,
   `429` count, per-worker in-flight) for an HPA/KEDA `metrics-api` scaler to poll.
6. **429 backpressure.** At capacity the service returns `429 + Retry-After`; Kibana surfaces it as a
   retryable error and Task Manager backs off.
7. **The config gate works.** Remove the `--xpack.screenshotting.service.*` flags and Kibana falls
   back to launching Chromium in-process exactly as today — zero regression.

> **Known issue:** PDF export with **"Optimize for printing" ON** (print layout) is currently
> **broken** — it produces a PDF full of loading indicators/errors and is slow. PNG and
> preserve-layout PDF work. See
> [Architecture → what works / what doesn't](./docs/architecture.md#what-works--what-doesnt)
> for the root-cause analysis.

---

## Run it (4 windows)

### Prerequisites

- Kibana repo bootstrapped (`yarn kbn bootstrap`)
- Kibana's vendored Chromium is already installed (it will be found automatically)

### Window 1 — Elasticsearch

```bash
yarn es snapshot --license trial
```

Wait for the green `Elasticsearch is now available` line.

**(Optional) create an ES API key** to exercise the `apiKey` path (otherwise the service uses an
`elastic:changeme` basic-auth fallback):

```bash
curl -s -u elastic:changeme -X POST http://localhost:9200/_security/api_key \
  -H 'Content-Type: application/json' -d '{"name":"reporting-poc"}' | jq -r .encoded
```

### Window 2 — API / router tier (no Chromium)

```bash
node x-pack/examples/reporting_service_poc/scripts/start_service.js
```

Options (all optional):
- `--port 8790` — service port
- `--worker-url http://127.0.0.1:8791` — worker base URL(s), comma-separated for several
- `--es-url http://localhost:9200` — Elasticsearch URL (for reading results)
- `--result-index reporting-service-poc-results` — ES index results are stored in
- `--concurrency 1` — max parallel renders (match total worker capacity)
- `--queue-depth 10` — max queued requests before 429

Wait for **`✓ Reporting API service listening on http://127.0.0.1:8790`**.

### Window 3 — render worker (owns Chromium)

```bash
node x-pack/examples/reporting_service_poc/scripts/start_worker.js
```

Options (all optional):
- `--port 8791` — worker port
- `--kibana-url http://localhost:5601` — Kibana URL the worker renders against
- `--es-url http://localhost:9200` — Elasticsearch URL (for writing results)
- `--result-index reporting-service-poc-results` — ES index results are written to

Wait for **`✓ Reporting worker listening on http://127.0.0.1:8791`**.

### Window 4 — Kibana (service mode enabled)

```bash
yarn start --run-examples --no-base-path \
  --xpack.screenshotting.service.enabled=true \
  --xpack.screenshotting.service.url=http://127.0.0.1:8790 \
  --xpack.screenshotting.service.mode=async \
  --xpack.screenshotting.service.apiKey=<encoded-key>   # optional; omit for basic-auth fallback
```

> To use synchronous mode instead: `--xpack.screenshotting.service.mode=sync`

Wait for Kibana to be ready (`Server running at http://localhost:5601`).

---

## Prove it

### Setup (once)

1. Log in at http://localhost:5601 (username: `elastic`, password: `changeme`)
2. Go to **Integrations** (or **Stack Management → Sample Data**) → add **Sample flight data**
3. Open the **[Flights] Global Flight Dashboard**

### Proof 1 — Downloadable artifact (end-to-end)

Dashboard → **Share** → **Export** → **PNG** or **PDF** → **Generate export**.

While the report is generating:
- **Window 4 (Kibana)** logs: `[service-client] Submitting async render job` and
  `[service-client] Job <id> complete — downloading artifact`
- **Window 2 (router)** logs: `async job queued: id=<id>`
- **Window 3 (worker)** logs the Chromium render and `wrote <n> bytes to reporting-service-poc-results`

The job appears in Stack Management → Reporting and eventually reaches `completed`. Download it and
verify it's a real rendering of the dashboard. You can also confirm the artifact landed in ES:

```bash
curl -s -u elastic:changeme \
  'http://localhost:9200/reporting-service-poc-results/_search?_source=jobId,contentType,bytes' | jq
```

### Proof 2 — Watch the queue via /metrics

```bash
curl -s http://127.0.0.1:8790/api/v1/metrics | jq
# → { activeRenders, queued, maxConcurrency, queueDepth, total429, totalCompleted, totalFailed, workers:[...] }
```

Generate a report and re-run to watch `activeRenders` / `workers[].inFlight` move.

### Proof 3 — Before/after toggle (proves the worker is doing the work)

1. With Windows 2 + 3 running, generate a report — it succeeds.
2. **Kill Window 3** (the worker) and immediately generate another report.
   - The router logs a dispatch error and the job reaches `failed` in Stack Management → Reporting.
3. **Restart Window 3** — reports succeed again.

**Optional — local fallback:** Restart Kibana *without* the `--xpack.screenshotting.service.*`
flags. Reports succeed via the original in-process Chromium path, proving the config gate.

### Proof 4 — 429 backpressure

```bash
# Make the router 429 immediately: one slot, no queue.
node x-pack/examples/reporting_service_poc/scripts/start_service.js --concurrency 1 --queue-depth 0

# While a report is rendering, submit a second one — the second gets 429.
# Check the Kibana log for: "Reporting service at capacity"; total429 climbs in /api/v1/metrics.
```

---

## API reference

### API / router tier — `http://127.0.0.1:8790` (what Kibana calls)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | `{"status":"ok","role":"api"}` |
| `GET` | `/api/v1/version` | API version info |
| `GET` | `/api/v1/metrics` | Live gauge for autoscaling |
| `POST` | `/api/v1/screenshot` | Sync render — blocks, returns binary artifact (read from ES) |
| `POST` | `/api/v1/jobs` | Async submit — returns `202 {"jobId":"..."}` |
| `GET` | `/api/v1/jobs/:id` | Job status: `pending│running│completed│failed` |
| `GET` | `/api/v1/jobs/:id/artifact` | Artifact bytes from ES (when status = `completed`) |

### Worker tier — `http://127.0.0.1:8791` (called by the router)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | `{"status":"ok","role":"worker"}` |
| `GET` | `/api/v1/metrics` | Per-worker active/total renders |
| `POST` | `/api/v1/render` | Render one request + write the artifact to ES |

Pass `Authorization: ApiKey <encoded-key>` on router requests to exercise the API-key path; the
router forwards it to the worker (reused for the ES write) and uses it for ES reads.

---

## File layout

```
x-pack/examples/reporting_service_poc/
├── kibana.jsonc                   Plugin manifest (near no-op; loaded with --run-examples)
├── tsconfig.json
├── README.md                      ← you are here (runbook)
├── docs/
│   ├── proposal.md                Mike's proposal (background)
│   ├── architecture.md            Three-tier design, HTTP API, what works / lifecycle
│   └── decisions.md               Options + D1–D10 decisions ledger
├── server/
│   ├── index.ts                   Plugin entry point
│   └── plugin.ts                  Near no-op Kibana plugin class
├── service/
│   ├── types.ts                   Shared types (RenderRequest, Job, worker + metrics types)
│   ├── render_pipeline.ts         Render harness: stubs core deps, reuses Kibana's Screenshots
│   ├── es_client.ts               Minimal ES client: ensure index / write / read result
│   ├── queue.ts                   Admission control: semaphore + bounded queue + 429 + metrics
│   ├── worker_pool.ts             Least-busy worker selection (router → workers)
│   ├── server.ts                  API / router HTTP server (Tier 2)
│   └── worker_server.ts           Worker HTTP server: render + write to ES (Tier 3)
└── scripts/
    ├── start_service.js           Launcher for the API / router tier
    └── start_worker.js            Launcher for a render worker
```

> The full design writeup (background, architecture, options, decisions, status) lives in
> [`./docs`](./docs).

### Kibana files changed

| File | Change |
|------|--------|
| `src/platform/packages/private/kbn-screenshotting-server/src/config/schema.ts` | `+service.{enabled,url,mode,apiKey}` config block |
| `x-pack/platform/plugins/shared/screenshotting/server/plugin.ts` | Config-gate service client in `start()` |
| `x-pack/platform/plugins/shared/screenshotting/server/service_client.ts` | New: HTTP client; sends `Authorization: ApiKey` |

---

## Scope and non-goals

This POC is **localhost-only** and **not production-ready**. Deliberately out of scope:

- **No TLS or hardened auth** — the API key is static/shared and travels over localhost HTTP; no
  per-job/short-lived/invalidate-on-complete keys
- **No real reporting-store integration** — the worker writes a single POC-index doc rather than
  Kibana's chunked `content_stream` into the real reporting data stream
- **No multi-tenant isolation** — one shared Chromium process per worker; no per-tenant browser pool
- **No egress allowlist** — no network policy enforcement at the service tier
- **No containerisation / K8s / HPA** — runs as plain Node.js processes
- **No durable job status** — the router's job-status registry is in-memory (artifacts are durable in ES)
- **No historical observability** — a live `/metrics` gauge exists, but no time-series metrics or tracing

All of the above is documented in [`./docs/decisions.md`](./docs/decisions.md)
as the productionisation work this POC is meant to inform.

---

## Key open questions for the team

1. **Render pipeline packaging (D1):** How does the worker ship without the full Kibana source tree?
2. **Repo location (D2):** New repo vs. in-monorepo for the service?
3. **Browser isolation (D3):** Process-per-request vs. per-tenant pool vs. pod-per-tenant?
4. **Auth + credential hardening (D4):** mTLS/service token? Short-lived per-job ES keys?
5. **Result storage (D6):** Reuse Kibana's chunked `content_stream` writer + scoped ES creds + durable
   job status (the POC writes a single doc with a shared key).
6. **Deployment (D8) + router tier (D9):** Fleet topology; durable backlog in Task Manager.
7. **Autoscaling (D10):** Layer a Task-Manager/report `_count` demand signal onto the router's
   saturation gauge.

See [`./docs/decisions.md`](./docs/decisions.md) for the full options/decisions ledger.
