/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Reporting Worker HTTP server (Layer 3 of the POC topology).
 *
 * Owns Chromium and the render pipeline. Receives a render request from the API
 * service (router), renders the artifact, and writes the bytes straight to
 * Elasticsearch under the job id (result-storage decision "A"). It returns only
 * metadata — the bytes never travel back through the router's memory.
 *
 * Routes (all under /api/v1):
 *   GET  /health   — liveness probe
 *   GET  /metrics  — live gauge (active + total renders on this worker)
 *   POST /render   — render one request and persist the result to ES
 */

import http from 'http';
import type { WorkerRenderRequest, WorkerRenderResponse } from './types';
import { render } from './render_pipeline';
import { writeResult } from './es_client';

const WORKER_API_VERSION = '1.0.0-poc';

const svcLog = {
  info: (msg: string) => process.stdout.write(`[INFO][worker] ${msg}\n`),
  error: (msg: string | Error) => process.stderr.write(`[ERROR][worker] ${String(msg)}\n`),
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

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'X-Reporting-Worker-Api-Version': WORKER_API_VERSION,
  });
  res.end(json);
}

export interface WorkerServerOptions {
  /** Fallback Authorization header for ES writes when the request carries none. */
  fallbackEsAuthorization?: string;
}

export function createWorkerServer(options: WorkerServerOptions = {}): http.Server {
  let activeRenders = 0;
  let totalRenders = 0;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/$/, '');

    try {
      if (req.method === 'GET' && path === '/api/v1/health') {
        send(res, 200, { status: 'ok', role: 'worker', apiVersion: WORKER_API_VERSION });
        return;
      }

      if (req.method === 'GET' && path === '/api/v1/metrics') {
        send(res, 200, { activeRenders, totalRenders });
        return;
      }

      if (req.method === 'POST' && path === '/api/v1/render') {
        const body = (await parseBody(req)) as WorkerRenderRequest;
        const { jobId, request, esUrl, resultIndex } = body;
        const authorization = body.authorization ?? options.fallbackEsAuthorization;

        activeRenders++;
        svcLog.info(
          `render start: job=${jobId} format=${request.format} urls=${request.urls.length} ` +
            `(active=${activeRenders})`
        );

        try {
          const data = await render(request);
          const contentType = request.format === 'pdf' ? 'application/pdf' : 'image/png';

          await writeResult({
            esUrl,
            index: resultIndex,
            id: jobId,
            contentType,
            data,
            authorization,
          });
          totalRenders++;
          svcLog.info(`render done: job=${jobId} wrote ${data.length} bytes to ${resultIndex}`);

          const response: WorkerRenderResponse = {
            ok: true,
            jobId,
            contentType,
            bytes: data.length,
          };
          send(res, 200, response);
        } finally {
          activeRenders--;
        }
        return;
      }

      send(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      svcLog.error(`render error: ${message}`);
      send(res, 500, { ok: false, error: message });
    }
  });
}
