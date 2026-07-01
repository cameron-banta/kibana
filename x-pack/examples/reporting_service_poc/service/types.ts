/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * The HTTP request body sent by Kibana to the reporting service.
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

export interface Job {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** The rendered artifact (base64-encoded bytes), set when status = 'completed' */
  resultBase64?: string;
  /** Error message, set when status = 'failed' */
  error?: string;
}
