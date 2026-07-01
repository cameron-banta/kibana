/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Standalone Reporting Service HTTP server.
 *
 * Implements the HTTP API described in Mike Cote's multi-tenant reporting service proposal.
 * Exposes both a synchronous and an async endpoint so the team can evaluate both patterns.
 *
 * Routes (all under /api/v1):
 *   GET  /health           — liveness probe
 *   GET  /version          — API version + Chromium info
 *   POST /screenshot       — synchronous: blocks until artifact is ready, returns bytes
 *   POST /jobs             — async: returns 202 + jobId immediately
 *   GET  /jobs/:id         — poll job status
 *   GET  /jobs/:id/artifact — download artifact bytes (when status = completed)
 */

import http from 'http';
import type { RenderRequest } from './types';
import type { RenderQueue } from './queue';
import { render } from './render_pipeline';

const SERVICE_API_VERSION = '1.0.0-poc';

/** Simple logger backed by process.stdout/stderr (service is a standalone Node.js script). */
const svcLog = {
  info: (msg: string) => process.stdout.write(`[INFO][service] ${msg}\n`),
  error: (msg: string | Error) => process.stderr.write(`[ERROR][service] ${String(msg)}\n`),
};

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

export function createServer(queue: RenderQueue): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const path = url.pathname.replace(/\/$/, '');

    try {
      // ── GET /api/v1/health ───────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/health') {
        send(res, 200, { status: 'ok', apiVersion: SERVICE_API_VERSION });
        return;
      }

      // ── GET /api/v1/version ──────────────────────────────────────────
      if (req.method === 'GET' && path === '/api/v1/version') {
        send(res, 200, {
          apiVersion: SERVICE_API_VERSION,
          description: 'Multi-tenant Reporting Service POC — Mike Cote proposal',
        });
        return;
      }

      // ── POST /api/v1/screenshot (sync) ───────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/screenshot') {
        if (queue.isAtCapacity) {
          send(
            res,
            429,
            { error: 'Service at capacity. Retry later.', retryAfter: queue.retryAfterSeconds },
            { 'Retry-After': String(queue.retryAfterSeconds) }
          );
          return;
        }

        const body = await parseBody(req);
        const renderReq = validateRenderRequest(body);

        svcLog.info(`sync render: format=${renderReq.format} urls=${renderReq.urls.length}`);

        const job = queue.createJob();
        await queue.run(job, () => render(renderReq));

        if (job.status === 'failed') {
          send(res, 500, { error: job.error ?? 'Render failed' });
          return;
        }

        const data = Buffer.from(job.resultBase64!, 'base64');
        const contentType = renderReq.format === 'pdf' ? 'application/pdf' : 'image/png';
        sendBinary(res, 200, contentType, data);
        return;
      }

      // ── POST /api/v1/jobs (async submit) ─────────────────────────────
      if (req.method === 'POST' && path === '/api/v1/jobs') {
        if (queue.isAtCapacity) {
          send(
            res,
            429,
            { error: 'Service at capacity. Retry later.', retryAfter: queue.retryAfterSeconds },
            { 'Retry-After': String(queue.retryAfterSeconds) }
          );
          return;
        }

        const body = await parseBody(req);
        const renderReq = validateRenderRequest(body);

        const job = queue.createJob();
        svcLog.info(`async job queued: id=${job.id} format=${renderReq.format}`);

        // Fire-and-forget: let queue.run() update job.status as it goes.
        queue
          .run(job, () => render(renderReq))
          .catch((err: Error) => {
            svcLog.error(`job ${job.id} error: ${err.message}`);
          });

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

      // ── GET /api/v1/jobs/:id/artifact ────────────────────────────────
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
        // We don't store the original format in the job for simplicity — derive from
        // resultBase64 magic bytes. PNG starts with \x89PNG; PDF starts with %PDF.
        const data = Buffer.from(job.resultBase64!, 'base64');
        const isPdf = data[0] === 0x25 && data[1] === 0x50; // %P
        const contentType = isPdf ? 'application/pdf' : 'image/png';
        sendBinary(res, 200, contentType, data);
        return;
      }

      // ── 404 ──────────────────────────────────────────────────────────
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      svcLog.error(`Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      send(
        res,
        err instanceof SyntaxError || (err as Error).message?.includes('Invalid JSON') ? 400 : 500,
        {
          error: err instanceof Error ? err.message : String(err),
        }
      );
    }
  });

  return server;
}
