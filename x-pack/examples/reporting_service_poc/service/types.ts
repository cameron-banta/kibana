/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * The HTTP request body sent by Kibana to the reporting API service.
 * Contains everything the service needs to navigate to a page and capture a screenshot.
 * All fields are JSON-serializable (auth headers are already strings).
 */
export interface RenderRequest {
  /** 'png' or 'pdf' */
  format: 'png' | 'pdf';
  /** Browser timezone to emulate */
  browserTimezone?: string;
  /** Layout parameters (id, dimensions, zoom, etc.) */
  layout?: Record<string, unknown>;
  /** URLs to capture. Each element can be a plain URL string or [url, context] tuple. */
  urls: Array<string | [string, Record<string, unknown>]>;
  /** Auth headers to inject into same-origin requests (e.g. Authorization: ApiKey ...) */
  headers: Record<string, string>;
  /** PDF title */
  title?: string;
  /** PDF logo (base64) */
  logo?: string;
  /** Task instance timing metadata — forwarded verbatim */
  taskInstanceFields?: { startedAt?: string; retryAt?: string };
}

/** Status for an async job */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Job record held by the API service (router). Note it holds only *metadata* — the
 * rendered artifact bytes live in Elasticsearch (written by the worker), never in
 * the router's memory. This is result-storage decision "A": worker writes ES directly.
 */
export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** MIME type of the stored artifact, set when status = 'completed'. */
  contentType?: string;
  /** Error message, set when status = 'failed' */
  error?: string;
}

/**
 * Request the API service (router) sends to a worker to perform a single render.
 * The worker renders and writes the artifact straight to Elasticsearch under `jobId`.
 */
export interface WorkerRenderRequest {
  /** The job id — used as the Elasticsearch document id for the result. */
  jobId: string;
  /** The render request forwarded from Kibana. */
  request: RenderRequest;
  /** Elasticsearch base URL the worker writes the result to. */
  esUrl: string;
  /** Elasticsearch index the result document is written to. */
  resultIndex: string;
  /**
   * Authorization header value the worker reuses to write the result to ES
   * (the same API key Kibana used to call the service). May be undefined, in
   * which case the worker falls back to its configured ES credentials.
   */
  authorization?: string;
}

/** Response a worker returns after rendering + persisting to Elasticsearch. */
export interface WorkerRenderResponse {
  ok: boolean;
  jobId: string;
  contentType: string;
  /** Number of artifact bytes written to ES (the bytes themselves are not returned). */
  bytes: number;
  error?: string;
}

/**
 * Live service metrics (autoscaling decision "1"): an ephemeral, in-memory gauge
 * the API service exposes at GET /api/v1/metrics for an autoscaler (HPA/KEDA
 * metrics-api scaler) to poll. Nothing here is persisted.
 */
export interface ServiceMetrics {
  /** Renders currently dispatched to workers. */
  activeRenders: number;
  /** Requests waiting in the bounded admission queue for a slot. */
  queued: number;
  /** Configured max parallel renders (sum of worker capacity). */
  maxConcurrency: number;
  /** Configured max queued requests before 429. */
  queueDepth: number;
  /** Total 429s returned since startup. */
  total429: number;
  /** Total renders completed since startup. */
  totalCompleted: number;
  /** Total renders failed since startup. */
  totalFailed: number;
  /** Per-worker in-flight snapshot. */
  workers: Array<{ url: string; inFlight: number }>;
}
