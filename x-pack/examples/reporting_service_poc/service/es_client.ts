/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Minimal Elasticsearch client for the POC result store.
 *
 * Result-storage decision "A": the worker writes the rendered artifact directly to
 * Elasticsearch (its final resting place), and the API service reads it back to serve
 * downloads. No object store, no broker, no in-memory result buffering.
 *
 * The artifact is stored base64-encoded in a `binary`-typed field so ES does not try
 * to analyze/index the bytes. This POC stores the whole artifact in a single document
 * for simplicity; Kibana's real Reporting store chunks content into ~1 MB documents
 * (see reporting/server/lib/content_stream.ts) — productionising would reuse that
 * chunk-writer contract instead.
 *
 * Uses the http/https core modules (no fetch) to match the rest of the POC and avoid
 * any global-type assumptions at type-check time.
 */

import http from 'http';
import https from 'https';

interface EsRequestArgs {
  method: string;
  url: string;
  /** Full Authorization header value, e.g. `ApiKey abc==` or `Basic ...`. */
  authorization?: string;
  body?: string;
}

function esRequest({
  method,
  url,
  authorization,
  body,
}: EsRequestArgs): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    if (authorization) {
      headers.authorization = authorization;
    }
    const options: https.RequestOptions = {
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
      // Local dev ES (yarn es snapshot) uses http; if pointed at https with a
      // self-signed cert, don't fail the handshake for this POC.
      rejectUnauthorized: false,
    };
    const req = lib.request(options, (res) => {
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

/** Create the result index (idempotent) with a mapping that does not index the bytes. */
export async function ensureResultIndex(args: {
  esUrl: string;
  index: string;
  authorization?: string;
}): Promise<void> {
  const { esUrl, index, authorization } = args;

  const head = await esRequest({ method: 'HEAD', url: `${esUrl}/${index}`, authorization });
  if (head.status === 200) {
    return;
  }

  const mapping = JSON.stringify({
    mappings: {
      properties: {
        jobId: { type: 'keyword' },
        contentType: { type: 'keyword' },
        bytes: { type: 'long' },
        '@timestamp': { type: 'date' },
        // `binary` fields are stored but not indexed — ideal for base64 artifact bytes.
        content: { type: 'binary' },
      },
    },
  });

  const put = await esRequest({
    method: 'PUT',
    url: `${esUrl}/${index}`,
    authorization,
    body: mapping,
  });
  if (put.status >= 300 && !put.body.includes('resource_already_exists')) {
    throw new Error(`Failed to create result index "${index}": ${put.status} ${put.body}`);
  }
}

/** Write a rendered artifact to ES as a single document keyed by job id. */
export async function writeResult(args: {
  esUrl: string;
  index: string;
  id: string;
  contentType: string;
  data: Buffer;
  authorization?: string;
}): Promise<void> {
  const { esUrl, index, id, contentType, data, authorization } = args;
  const body = JSON.stringify({
    jobId: id,
    contentType,
    bytes: data.length,
    '@timestamp': new Date().toISOString(),
    content: data.toString('base64'),
  });
  const resp = await esRequest({
    method: 'PUT',
    url: `${esUrl}/${index}/_doc/${encodeURIComponent(id)}?refresh=wait_for`,
    authorization,
    body,
  });
  if (resp.status >= 300) {
    throw new Error(`Elasticsearch result write failed: ${resp.status} ${resp.body}`);
  }
}

/** Read a rendered artifact back from ES. Returns null when the document is not found. */
export async function readResult(args: {
  esUrl: string;
  index: string;
  id: string;
  authorization?: string;
}): Promise<{ contentType: string; data: Buffer } | null> {
  const { esUrl, index, id, authorization } = args;
  const resp = await esRequest({
    method: 'GET',
    url: `${esUrl}/${index}/_doc/${encodeURIComponent(id)}`,
    authorization,
  });
  if (resp.status === 404) {
    return null;
  }
  if (resp.status >= 300) {
    throw new Error(`Elasticsearch result read failed: ${resp.status} ${resp.body}`);
  }
  const source = (JSON.parse(resp.body) as { _source?: { contentType?: string; content?: string } })
    ._source;
  if (!source?.content) {
    return null;
  }
  return {
    contentType: source.contentType ?? 'application/octet-stream',
    data: Buffer.from(source.content, 'base64'),
  };
}
