/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * ServiceScreenshotClient — Kibana side of the multi-tenant reporting service integration.
 *
 * Replaces the local `Screenshots.getScreenshots()` call when
 * `xpack.screenshotting.service.enabled = true`. Serialises the screenshot options and
 * auth headers into an HTTP request to the standalone reporting service, then adapts
 * the response back into the exact ScreenshotResult object that reporting expects.
 *
 * This is the seam described in Mike Cote's proposal:
 *   "When a reporting task runs in Kibana, instead of spawning Chromium locally,
 *    Kibana will send a request to the Multi-Tenanted Reporting Service."
 *
 * Security note (POC):
 *   Auth headers travel in plaintext over localhost HTTP. Production requires mTLS
 *   between Kibana and the service + per-job short-lived credentials.
 *   See docs/poc-status.md for the full list of what still needs to be built.
 */

import https from 'https';
import http from 'http';
import type { Logger } from '@kbn/core/server';
import type { Observable } from 'rxjs';
import { from } from 'rxjs';
import type { ScreenshotOptions, ScreenshotResult } from './screenshots';

// Poll interval for async mode (ms)
const ASYNC_POLL_INTERVAL_MS = 2_000;
// Maximum time to wait for an async job (ms) — should exceed capture.timeouts.renderComplete
const ASYNC_MAX_WAIT_MS = 180_000;

function stripSensitiveHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const allowList = new Set([
    'authorization',
    'cookie',
    'x-elastic-internal-origin',
    'kbn-xsrf',
    'x-kbn-context',
    'x-forwarded-for',
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (allowList.has(key.toLowerCase()) && value !== undefined) {
      out[key] = Array.isArray(value) ? value.join('; ') : (value as string);
    }
  }
  return out;
}

function httpRequest(
  url: string,
  options: http.RequestOptions,
  body?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function httpGetBuffer(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          buffer: Buffer.concat(chunks),
          contentType: res.headers['content-type'] ?? '',
        })
      );
    });
    req.on('error', reject);
  });
}

function httpPostBinary(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; buffer: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const parsedUrl = new URL(url);
    const req = lib.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'] ?? '',
          })
        );
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Build a minimal ScreenshotResult from raw bytes + content type. */
function buildResult(buffer: Buffer, contentType: string, format: string): ScreenshotResult {
  if (format === 'pdf' || contentType.includes('pdf')) {
    return {
      metrics: {},
      data: buffer,
      errors: [],
      renderErrors: [],
    } as unknown as ScreenshotResult;
  }

  // PNG — reconstruct a CaptureResult (= PngScreenshotResult)
  return {
    metrics: undefined,
    results: [
      {
        timeRange: null,
        screenshots: [{ data: buffer }],
        renderErrors: [],
      },
    ],
  } as unknown as ScreenshotResult;
}

export class ServiceScreenshotClient {
  constructor(
    private readonly serviceUrl: string,
    private readonly mode: 'sync' | 'async',
    private readonly logger: Logger,
    private readonly apiKey?: string
  ) {}

  /**
   * Auth header sent to the reporting service. The service reuses this same key
   * to read/write the rendered artifact in Elasticsearch (result-storage "A").
   */
  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {};
  }

  getScreenshots(options: ScreenshotOptions): Observable<ScreenshotResult> {
    return from(this.renderViaService(options));
  }

  private async renderViaService(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const req = options as unknown as Record<string, unknown>;

    // Merge auth headers the same way Screenshots.getCaptureOptions() does.
    const requestHeaders =
      (req.request as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
    const optionHeaders = (req.headers as Record<string, string> | undefined) ?? {};
    const mergedHeaders = {
      ...stripSensitiveHeaders(requestHeaders as Record<string, string>),
      ...optionHeaders,
    };

    const format: string = (req.format as string) ?? 'png';

    const payload = {
      format,
      browserTimezone: req.browserTimezone as string | undefined,
      layout: req.layout as Record<string, unknown> | undefined,
      urls: req.urls as Array<string | [string, Record<string, unknown>]>,
      headers: mergedHeaders,
      title: (req as { title?: string }).title,
      logo: (req as { logo?: string }).logo,
      taskInstanceFields: req.taskInstanceFields as Record<string, string> | undefined,
    };

    if (this.mode === 'sync') {
      return this.renderSync(payload, format);
    }
    return this.renderAsync(payload, format);
  }

  private async renderSync(payload: unknown, format: string): Promise<ScreenshotResult> {
    const body = JSON.stringify(payload);
    const url = `${this.serviceUrl}/api/v1/screenshot`;
    this.logger.info(`[service-client] Sending sync render request to ${url}`);

    const response = await httpPostBinary(
      url,
      {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        ...this.authHeaders(),
      },
      body
    );

    if (response.status === 429) {
      let retryAfter: number | undefined;
      try {
        retryAfter = (JSON.parse(response.buffer.toString()) as { retryAfter?: number }).retryAfter;
      } catch {
        // ignore parse error
      }
      throw Object.assign(new Error('Reporting service at capacity'), {
        isRetryable: true,
        retryAfter,
      });
    }

    if (response.status !== 200) {
      throw new Error(`Reporting service error ${response.status}: ${response.buffer.toString()}`);
    }

    this.logger.info(`[service-client] Sync render complete (${response.buffer.length} bytes)`);
    return buildResult(response.buffer, response.contentType, format);
  }

  private async renderAsync(payload: unknown, format: string): Promise<ScreenshotResult> {
    const body = JSON.stringify(payload);
    const submitUrl = `${this.serviceUrl}/api/v1/jobs`;
    this.logger.info(`[service-client] Submitting async render job to ${submitUrl}`);

    const submitResponse = await httpRequest(
      submitUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          ...this.authHeaders(),
        },
      },
      body
    );

    if (submitResponse.status === 429) {
      const parsed = JSON.parse(submitResponse.body) as { retryAfter?: number };
      throw Object.assign(new Error('Reporting service at capacity'), {
        isRetryable: true,
        retryAfter: parsed.retryAfter,
      });
    }

    if (submitResponse.status !== 202) {
      throw new Error(
        `Reporting service submit error ${submitResponse.status}: ${submitResponse.body}`
      );
    }

    const { jobId } = JSON.parse(submitResponse.body) as { jobId: string };
    this.logger.info(`[service-client] Job submitted: ${jobId} — polling for completion …`);

    // Poll until complete or timeout
    const pollUrl = `${this.serviceUrl}/api/v1/jobs/${jobId}`;
    const deadline = Date.now() + ASYNC_MAX_WAIT_MS;

    while (Date.now() < deadline) {
      await sleep(ASYNC_POLL_INTERVAL_MS);

      const statusResp = await httpRequest(pollUrl, {
        method: 'GET',
        headers: this.authHeaders(),
      });
      if (statusResp.status !== 200) {
        throw new Error(`Status poll error ${statusResp.status}: ${statusResp.body}`);
      }

      const job = JSON.parse(statusResp.body) as {
        status: string;
        error?: string;
      };

      this.logger.debug(`[service-client] Job ${jobId} status: ${job.status}`);

      if (job.status === 'failed') {
        throw new Error(`Rendering service reported failure: ${job.error ?? 'unknown error'}`);
      }

      if (job.status === 'completed') {
        const artifactUrl = `${this.serviceUrl}/api/v1/jobs/${jobId}/artifact`;
        this.logger.info(`[service-client] Job ${jobId} complete — downloading artifact`);

        const { buffer, contentType } = await httpGetBuffer(artifactUrl, this.authHeaders());
        this.logger.info(`[service-client] Artifact downloaded: ${buffer.length} bytes`);

        return buildResult(buffer, contentType, format);
      }
    }

    throw new Error(
      `Reporting service job ${jobId} did not complete within ${ASYNC_MAX_WAIT_MS / 1000}s`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
