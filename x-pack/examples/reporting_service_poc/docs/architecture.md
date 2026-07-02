# Reporting Service POC — Architecture & behavior

> Part of the multi-tenant reporting service POC. See also:
> [Mike's proposal](./proposal.md) · [Options, decisions & open questions](./decisions.md) ·
> [Runbook](../README.md).

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
- **Elasticsearch:** the single result store (result-storage decision **A** — see
  [D6](./decisions.md#d6-result-storage-who-writes-to-es)).

> **Design direction beyond the POC:** the tiers above are what the POC *builds today*
> (worker-writes-ES, Node/Puppeteer, in-process). The forward design leans to an async **result
> callback** (worker POSTs the artifact back to Kibana, which owns storage), a **Go control plane +
> containerized Chromium renderer image** (patched via an updatecli/GitOps pipeline), **one image that
> runs standalone and in K8s/Serverless**, and a **generic, multi-consumer** render contract. See
> decisions [D6](./decisions.md#d6-result-storage-who-writes-to-es),
> [D7](./decisions.md#d7-failure-behavior--result-delivery), and D11–D14.

---

## What this POC does

Reporting calls exactly one seam: `ScreenshottingStart.getScreenshots(options)` in
`x-pack/platform/plugins/shared/screenshotting/server/plugin.ts`. The `options` reporting passes
(`{ format, browserTimezone, layout, urls + locator context, request.headers, taskInstanceFields }`)
are **fully JSON-serializable** — which is exactly "all the information required to navigate and
capture" from Mike's doc.

The POC:

1. **Adds config** (`xpack.screenshotting.service.*`, defined in `@kbn/screenshotting-server`'s
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
   in-flight) as the autoscaling signal (decision **1** — see
   [D10](./decisions.md#d10-autoscaling-signal)).

> ⚠️ **How the worker gets the render pipeline today:** it imports Kibana's plugin-internal
> modules directly (via `@kbn/setup-node-env`) from the same source tree. This is the single
> biggest "not production-ready" shortcut — see
> [decision D1](./decisions.md#d1-how-does-the-service-get-the-render-pipeline).

### Kibana logic embedded in the worker today

"Turn a web page into a PDF/PNG" sounds trivial, but the worker currently carries a lot of
**Kibana-specific render logic** (all of it pulled from Kibana's source tree). This is the concrete
surface that any productionization has to find a home for — either extract it into a versioned
package (D1 Option A) or re-express it as a generic contract so the service stops knowing about
Kibana (D1 Option B):

| Kibana "smart" | Where it lives | What it does |
|---|---|---|
| `Screenshots` orchestrator | `screenshotting/server/screenshots/screenshots.ts` | drives the whole capture flow per URL |
| Chromium management | `@kbn/screenshotting-server` (`HeadlessChromiumDriverFactory`, `install`, `ChromiumArchivePaths`, `getChromiumPackage`, `createConfig`) | downloads/launches Chromium, builds the config shape |
| **Render-complete detection** | `get_number_of_items.ts`, `wait_for_visualizations.ts`, `wait_for_render.ts` | waits on the `data-shared-items-count` hint + per-item `data-render-complete` attributes |
| **Screenshot-mode injection** | `screenshot_mode/common` (`setScreenshotModeEnabled`, `setScreenshotContext`) | injected into the page **before navigation** so the Kibana app renders in screenshot mode |
| **Layout + CSS overrides** | layouts + `inject_css.ts` + `APP_WRAPPER_CLASS` (`@kbn/core`) | hides chrome, applies preserve/print layout CSS |
| Element metadata scraping | `get_element_position_data.ts`, `get_render_errors.ts`, `get_time_range.ts` | element positions/dimensions, render-error text, time range |
| **PDF assembly** | `get_pdf.ts` (pdfmake) vs native `page.pdf()` | stitches panel screenshots into a PDF, or prints the whole page |
| Core stubs it must fake | `service/render_pipeline.ts` | `HttpServiceSetup`, `PackageInfo`, `Logger`, network-policy config |

The **bold** rows are the "smarts" a generic renderer would not know on its own — the ones D1
Option B has to either move into a Kibana-served page or carry as opaque data in a render recipe.

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

> See the [runbook](../README.md) for how to start each tier and reproduce the proofs.

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

- **PDF export with "Optimize for printing" ON** (print layout).
  It produces a PDF, but the pages are full of loading spinners and render errors instead
  of charts, and it takes much longer (~60s vs ~10s).
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
isolation model is a real decision — see [D3](./decisions.md#d3-browser-isolation-model).
