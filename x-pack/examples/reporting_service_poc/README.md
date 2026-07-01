# Multi-tenant Reporting Service POC

Proof-of-concept for Mike Cote's multi-tenant reporting service proposal.

> **📖 Canonical writeup:** the full background (summary of Mike's proposal + link), what works /
> what doesn't, browser-isolation discussion, and the options/decisions ledger live in
> [`src/platform/packages/private/kbn-screenshotting-server/README.md`](../../../src/platform/packages/private/kbn-screenshotting-server/README.md).
> This file is just the practical runbook for the example plugin + service.

**Core thesis:** Instead of spawning Chromium inside Kibana, Kibana sends an HTTP request to a
standalone service. The service owns Chromium and the full render pipeline, renders the report,
and returns the artifact bytes. Kibana's CPU/RAM is no longer affected by rendering.

This is a **local-only proof of concept** intended for sharing on a private branch so the team
can run it and ask questions. It is not intended for merge to `main`.

---

## What this proves

1. **The decoupling works end-to-end.** Kibana can generate a real PNG or PDF report by calling
   an external HTTP service that owns Chromium — with no change to reporting, Task Manager, or any
   export type.

2. **Sync and async interaction models.** The service exposes both a synchronous endpoint
   (blocks until done) and an async job model (submit → poll → download), demonstrating the
   contract Mike described.

3. **429 backpressure.** When the service is at capacity, it returns `429 + Retry-After`.
   Kibana surfaces this as a retryable error; Task Manager backs off.

4. **The config gate works.** Remove the `--xpack.screenshotting.service.*` flags and Kibana
   falls back to launching Chromium in-process exactly as today — zero regression.

> **Known issue:** PDF export with **"Optimize for printing" ON** (print layout) is currently
> **broken** — it produces a PDF full of loading indicators/errors and is slow. PNG and
> preserve-layout PDF work. See the
> [`@kbn/screenshotting-server` README](../../../src/platform/packages/private/kbn-screenshotting-server/README.md#what-works--what-doesnt)
> for the root-cause analysis.

---

## Run it (3 windows)

### Prerequisites

- Kibana repo bootstrapped (`yarn kbn bootstrap`)
- Kibana's vendored Chromium is already installed (it will be found automatically)
- Elasticsearch running

### Window 1 — Elasticsearch

```bash
yarn es snapshot --license trial
```

Wait for the green `Elasticsearch is now available` line.

### Window 3 — Reporting Service

```bash
node x-pack/examples/reporting_service_poc/scripts/start_service.js
```

Options (all optional):
- `--port 8790` — service port (default: `8790`)
- `--kibana-url http://localhost:5601` — Kibana URL the service renders against
- `--concurrency 2` — max parallel renders
- `--queue-depth 10` — max queued requests before 429

Wait for: **`✓ Reporting service listening on http://127.0.0.1:8790`**

### Window 2 — Kibana (service mode enabled)

```bash
yarn start --run-examples --no-base-path \
  --xpack.screenshotting.service.enabled=true \
  --xpack.screenshotting.service.url=http://127.0.0.1:8790 \
  --xpack.screenshotting.service.mode=async
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

**Via the UI:**

Dashboard → **Share** → **Export** → **PNG** or **PDF** → **Generate export**

While the report is generating:
- **Window 2** logs: `[service-client] Submitting async render job` and
  `[service-client] Job <id> complete — downloading artifact`
- **Window 3** logs: `[service] async job queued: id=<id>` and Chromium render activity

The job appears in Stack Management → Reporting and eventually reaches `completed` status.
Download it and verify the image/PDF is a real rendering of the dashboard.

**Via curl:**

```bash
# Step 1: queue a PNG report (async mode)
REPORT=$(curl -s -X POST http://localhost:5601/api/reporting/generate/pngV2 \
  -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
  -u elastic:changeme \
  -d '{"jobParams":"(browserTimezone:America/Chicago,layout:(dimensions:(height:612,width:792),id:preserve_layout),locatorParams:(id:DASHBOARD_APP_LOCATOR,params:(dashboardId:7adfa750-4c81-11e8-b3d7-01146121b73d,preserveSavedFilters:!t,timeRange:(from:now-24h,to:now),useHash:!f,viewMode:view)),objectType:dashboard,title:\\'[Flights] Global Flight Dashboard\\',version:\\'9.x.0-poc\\')"}')
echo "Report queued: $REPORT"
DOC_ID=$(echo $REPORT | node -e "process.stdin.setEncoding('utf8'); let d=''; process.stdin.on('data', c => d+=c); process.stdin.on('end', () => console.log(JSON.parse(d).job.id))")

# Step 2: poll until complete
until curl -s http://localhost:5601/api/reporting/jobs/download/$DOC_ID \
  -u elastic:changeme --head | grep -q "200 OK"; do
  echo "Waiting…"; sleep 3
done

# Step 3: download the file
curl -o /tmp/report.png http://localhost:5601/api/reporting/jobs/download/$DOC_ID \
  -u elastic:changeme
echo "Saved to /tmp/report.png — open it to verify"
open /tmp/report.png  # macOS
```

### Proof 2 — Before/after toggle (proves the service is doing the work)

1. With Window 3 running, generate a report — it succeeds.
2. **Kill Window 3** (Ctrl-C) and immediately generate another report.
   - Window 2 logs: `[service-client] Submitting async render job` then an HTTP connection error.
   - The job reaches `failed` status in Stack Management → Reporting.
3. **Restart Window 3** (`node x-pack/examples/reporting_service_poc/scripts/start_service.js`).
   - Reports succeed again.

**Optional — local fallback:** Restart Kibana *without* the `--xpack.screenshotting.service.*`
flags. Reports succeed via the original in-process Chromium path, proving the config gate.

### Proof 3 — 429 backpressure

```bash
# Set concurrency=1, queue-depth=0 to make the service immediately 429
node x-pack/examples/reporting_service_poc/scripts/start_service.js \
  --concurrency 1 --queue-depth 0

# While a report is rendering, submit a second one — the second gets 429
# Check the Kibana log for: "Reporting service at capacity"
```

---

## API reference

Base URL: `http://127.0.0.1:8790`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | `{"status":"ok"}` |
| `GET` | `/api/v1/version` | API version info |
| `POST` | `/api/v1/screenshot` | Sync render — blocks, returns binary artifact |
| `POST` | `/api/v1/jobs` | Async submit — returns `202 {"jobId":"..."}` |
| `GET` | `/api/v1/jobs/:id` | Job status: `pending│running│completed│failed` |
| `GET` | `/api/v1/jobs/:id/artifact` | Artifact bytes (when status = `completed`) |

### Example: direct async call to the service

```bash
# Submit
curl -X POST http://127.0.0.1:8790/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{
    "format": "png",
    "browserTimezone": "America/Chicago",
    "layout": {"id":"preserve_layout","dimensions":{"width":1950,"height":1200}},
    "urls": ["http://localhost:5601/app/r/"],
    "headers": {"Authorization": "Basic ZWxhc3RpYzpjaGFuZ2VtZQ=="}
  }'
# → {"jobId":"<uuid>","status":"pending"}

# Poll
curl http://127.0.0.1:8790/api/v1/jobs/<uuid>
# → {"jobId":"...","status":"completed","..."}

# Download
curl -o /tmp/direct.png http://127.0.0.1:8790/api/v1/jobs/<uuid>/artifact
open /tmp/direct.png
```

---

## File layout

```
x-pack/examples/reporting_service_poc/
├── kibana.jsonc                   Plugin manifest (near no-op; loaded with --run-examples)
├── tsconfig.json
├── README.md                      ← you are here
├── server/
│   ├── index.ts                   Plugin entry point
│   └── plugin.ts                  Near no-op Kibana plugin class
├── service/
│   ├── types.ts                   Shared types (RenderRequest, Job)
│   ├── render_pipeline.ts         Render harness: stubs core deps, reuses Kibana's Screenshots
│   ├── queue.ts                   Semaphore + bounded queue + 429
│   └── server.ts                  HTTP server: sync + async routes
└── scripts/
    └── start_service.js           Launcher (the reporting service window)
```

> The full design writeup (background, options, decisions, status) lives in the
> [`@kbn/screenshotting-server` README](../../../src/platform/packages/private/kbn-screenshotting-server/README.md).

### Kibana files changed

| File | Change |
|------|--------|
| `src/platform/packages/private/kbn-screenshotting-server/src/config/schema.ts` | `+service.{enabled,url,mode}` config block |
| `x-pack/platform/plugins/shared/screenshotting/server/plugin.ts` | Config-gate service client in `start()` |
| `x-pack/platform/plugins/shared/screenshotting/server/service_client.ts` | New: HTTP client |

---

## Scope and non-goals

This POC is **localhost-only** and **not production-ready**. Deliberately out of scope:

- **No mTLS or service auth** — auth headers travel in plaintext on localhost HTTP
- **No credential hardening** — per-job keys are not short-lived or invalidated on complete
- **No multi-tenant isolation** — one shared Chromium process; no per-tenant browser pool
- **No egress allowlist** — no network policy enforcement at the service tier
- **No containerisation / K8s / HPA** — runs as a plain Node.js process
- **No object store** — artifact bytes held in-memory; lost on service restart
- **No observability** — console logging only; no metrics, tracing, or structured logs

All of the above is documented in the [`@kbn/screenshotting-server` README](../../../src/platform/packages/private/kbn-screenshotting-server/README.md)
as the productionisation work this POC is meant to inform.

---

## Key open questions for the team

1. **Render pipeline packaging:** How does the service ship without the full Kibana source tree?
   Extract `@kbn/screenshotting-render`? Send a "render recipe"? Keep it Kibana-aware?

2. **Multi-tenant isolation:** Shared Chromium process (per-job `BrowserContext`) vs. per-tenant
   browser pool vs. pod-per-tenant? Needs a security sign-off.

3. **Auth at Boundary 1:** mTLS + service token? Short-lived bearer token per job? Something else?

4. **Credential hardening:** When do we move to late-mint, short-expiry, invalidate-on-complete
   per-job keys? This is independent of which option ships.

5. **Deployment model:** One K8s Deployment per cloud provider with HPA? Sidecar? How does
   on-prem/ESS opt in?

See the [`@kbn/screenshotting-server` README](../../../src/platform/packages/private/kbn-screenshotting-server/README.md)
for the full options/decisions ledger.
