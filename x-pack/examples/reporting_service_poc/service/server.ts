/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Reporting API service — the router tier (Layer 2 of the POC topology).
 *
 * Sits between Kibana and the render workers. It owns admission control
 * (concurrency + bounded queue + 429), routes each accepted render to a worker
 * over HTTP, and exposes a /metrics gauge for autoscaling. It does NOT run
 * Chromium and does NOT hold artifact bytes: workers write results to
 * Elasticsearch, and this tier reads them back from ES to serve downloads.
 *
 * Routes (all under /api/v1):
 *   GET  /health           — liveness probe
 *   GET  /version          — API version
 *   GET  /metrics          — live gauge for HPA/KEDA (active renders, queue depth, 429s)
 *   POST /screenshot       — synchronous: blocks until artifact is ready, returns bytes
 *   POST /jobs             — async: returns 202 + jobId immediately
 *   GET  /jobs/:id         — poll job status
 *   GET  /jobs/:id/artifact — download artifact bytes (read from ES) when completed
 */

import http from 'http';
import type { RenderRequest, WorkerRenderRequest, WorkerRenderResponse } from './types';
import type { RenderQueue } from './queue';
import type { WorkerPool } from './worker_pool';
import { readResult } from './es_client';

const SERVICE_API_VERSION = '1.0.0-poc';

const svcLog = {
  info: (msg: string) => process.stdout.write(`[INFO][service] ${msg}\n`),
  error: (msg: string | Error) => process.stderr.write(`[ERROR][service] ${String(msg)}\n`),
};

export interface RouterConfig {
  esUrl: string;
  resultIndex: string;
  /** Fallback Authorization header for ES reads when the request carries none. */
  fallbackEsAuthorization?: string;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...extraHeaders,
  });
  res.end(json);
}

function sendBinary(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  data: Buffer
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'X-Reporting-Service-Api-Version': SERVICE_API_VERSION,
  });
  res.end(data);
}

function validateRenderRequest(body: unknown): RenderRequest {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Request body must be an object');
  }
  const req = body as Record<string, unknown>;
  if (req.format !== 'png' && req.format !== 'pdf') {
    throw new Error('format must be "png" or "pdf"');
  }
  if (!Array.isArray(req.urls) || req.urls.length === 0) {
    throw new Error('urls must be a non-empty array');
  }
  if (typeof req.headers !== 'object' || req.headers === null) {
    throw new Error('headers must be an object');
  }
  return {
    format: req.format,
    browserTimezone: typeof req.browserTimezone === 'string' ? req.browserTimezone : undefined,
    layout:
      typeof req.layout === 'object' && req.layout
        ? (req.layout as Record<string, unknown>)
        : undefined,
    urls: req.urls as RenderRequest['urls'],
    headers: req.headers as Record<string, string>,
    title: typeof req.title === 'string' ? req.title : undefined,
    logo: typeof req.logo === 'string' ? req.logo : undefined,
    taskInstanceFields:
      typeof req.taskInstanceFields === 'object' && req.taskInstanceFields
        ? (req.taskInstanceFields as RenderRequest['taskInstanceFields'])
        : undefined,
  };
}

/** POST JSON to a worker and parse the JSON response. */
function postJson(
  url: string,
  payload: unknown
): Promise<{ status: number; body: WorkerRenderResponse }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const json = JSON.stringify(payload);
    const req = http.request(
      {
        method: 'POST',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(data) as WorkerRenderResponse,
            });
          } catch {
            reject(new Error(`Worker returned non-JSON response (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

export function createServer(
  queue: RenderQueue,
  pool: WorkerPool,
  config: RouterConfig
): http.Server {
  const { esUrl, resultIndex, fallbackEsAuthorization } = config;

  /** Dispatch one render to the least-busy worker; resolves once ES has the result. */
  const dispatchToWorker = async (
    jobId: string,
    request: RenderRequest,
    authorization?: string
  ): Promise<{ contentType: string }> => {
    const workerUrl = pool.pick();
    pool.markBusy(workerUrl);
    try {
      const workerRequest: WorkerRenderRequest = {
        jobId,
        request,
        esUrl,
        resultIndex,
        authorization: authorization ?? fallbackEsAuthorization,
      };
      const { status, body } = await postJson(`${workerUrl}/api/v1/render`, workerRequest);
      if (status !== 200 || !body.ok) {
        throw new Error(body?.error ?? `Worker render failed with status ${status}`);
      }
      return { contentType: body.contentType };
    } finally {
      pool.markFree(workerUrl);
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/$/, '');
    const authorization = req.headers.authorization ?? fallbackEsAuthorization;

    try {
      // ── GET /api/v1/health ───────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/health') {
        send(res, 200, { status: 'ok', role: 'api', apiVersion: SERVICE_API_VERSION });
        return;
      }

      // ── GET /api/v1/version ──────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/version') {
        send(res, 200, {
          apiVersion: SERVICE_API_VERSION,
          description: 'Multi-tenant Reporting Service POC — API/router tier',
        });
        return;
      }

      // ── GET /api/v1/metrics (autoscaling gauge) ──────────────────────
      if (req.method === 'GET' && path === '/api/v1/metrics') {
        send(res, 200, queue.metrics(pool.snapshot()));
        return;
      }

      // ── POST /api/v1/screenshot (sync) ───────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/screenshot') {
        if (queue.isAtCapacity) {
          queue.record429();
          send(
            res,
            429,
            { error: 'Service at capacity. Retry later.', retryAfter: queue.retryAfterSeconds },
            { 'Retry-After': String(queue.retryAfterSeconds) }
          );
          return;
        }

        const renderReq = validateRenderRequest(await parseBody(req));
        svcLog.info(`sync render: format=${renderReq.format} urls=${renderReq.urls.length}`);

        const job = queue.createJob();
        await queue.run(job, () => dispatchToWorker(job.id, renderReq, authorization));

        if (job.status === 'failed') {
          send(res, 500, { error: job.error ?? 'Render failed' });
          return;
        }

        const result = await readResult({ esUrl, index: resultIndex, id: job.id, authorization });
        if (!result) {
          send(res, 500, { error: 'Result not found in Elasticsearch after render' });
          return;
        }
        sendBinary(res, 200, result.contentType, result.data);
        return;
      }

      // ── POST /api/v1/jobs (async submit) ─────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/jobs') {
        if (queue.isAtCapacity) {
          queue.record429();
          send(
            res,
            429,
            { error: 'Service at capacity. Retry later.', retryAfter: queue.retryAfterSeconds },
            { 'Retry-After': String(queue.retryAfterSeconds) }
          );
          return;
        }

        const renderReq = validateRenderRequest(await parseBody(req));
        const job = queue.createJob();
        svcLog.info(`async job queued: id=${job.id} format=${renderReq.format}`);

        // Fire-and-forget: queue.run() updates job.status; the worker writes the
        // result to ES. The download route reads it back from ES.
        queue
          .run(job, () => dispatchToWorker(job.id, renderReq, authorization))
          .catch((err: Error) => svcLog.error(`job ${job.id} error: ${err.message}`));

        send(res, 202, { jobId: job.id, status: job.status });
        return;
      }

      // ── GET /api/v1/jobs/:id (status) ────────────────────────────────
      const jobStatusMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (req.method === 'GET' && jobStatusMatch) {
        const job = queue.getJob(jobStatusMatch[1]);
        if (!job) {
          send(res, 404, { error: 'Job not found' });
          return;
        }
        send(res, 200, {
          jobId: job.id,
          status: job.status,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: job.error,
        });
        return;
      }

      // ── GET /api/v1/jobs/:id/artifact (read from ES) ─────────────────
      const artifactMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/artifact$/);
      if (req.method === 'GET' && artifactMatch) {
        const job = queue.getJob(artifactMatch[1]);
        if (!job) {
          send(res, 404, { error: 'Job not found' });
          return;
        }
        if (job.status !== 'completed') {
          send(res, 409, { error: 'Job not yet completed', status: job.status });
          return;
        }
        const result = await readResult({
          esUrl,
          index: resultIndex,
          id: job.id,
          authorization,
        });
        if (!result) {
          send(res, 404, { error: 'Artifact not found in Elasticsearch' });
          return;
        }
        sendBinary(res, 200, result.contentType, result.data);
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      svcLog.error(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      send(
        res,
        err instanceof SyntaxError || (err as Error).message?.includes('Invalid JSON') ? 400 : 500,
        { error: err instanceof Error ? err.message : String(err) }
      );
    }
  });

  return server;
}
