/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Admission-control queue for the API service (router).
 *
 * Limits how many renders are dispatched to workers simultaneously. When the
 * active count equals maxConcurrency and the bounded wait-queue is full, further
 * requests receive 429 + Retry-After — the backpressure contract from Mike's doc.
 *
 * It also maintains the live counters exposed at GET /api/v1/metrics for
 * autoscaling (decision "1"). It does NOT hold artifact bytes: rendered results
 * live in Elasticsearch (written by the worker), so the job record here is just
 * status metadata.
 */

import crypto from 'crypto';
import type { Job, ServiceMetrics } from './types';

export class RenderQueue {
  private active = 0;
  private jobs = new Map<string, Job>();
  private pendingQueue: Array<() => void> = [];

  private total429 = 0;
  private totalCompleted = 0;
  private totalFailed = 0;

  constructor(private readonly maxConcurrency: number, private readonly maxQueueDepth: number) {}

  /** True when there is no room to accept a new job. */
  public get isAtCapacity(): boolean {
    return this.active >= this.maxConcurrency && this.pendingQueue.length >= this.maxQueueDepth;
  }

  /**
   * How many seconds the caller should wait before retrying.
   * Rough estimate: (queue depth + 1) × average render time (30 s per Mike's doc).
   */
  public get retryAfterSeconds(): number {
    return (this.pendingQueue.length + 1) * 30;
  }

  /** Record that a 429 was returned (called by the server). */
  public record429(): void {
    this.total429++;
  }

  /** Live gauge for the /metrics endpoint. `workers` is filled in by the server. */
  public metrics(workers: ServiceMetrics['workers']): ServiceMetrics {
    return {
      activeRenders: this.active,
      queued: this.pendingQueue.length,
      maxConcurrency: this.maxConcurrency,
      queueDepth: this.maxQueueDepth,
      total429: this.total429,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      workers,
    };
  }

  /** Create a new job record in 'pending' state. Returns the job. */
  createJob(): Job {
    const id = crypto.randomUUID();
    const job: Job = { id, status: 'pending', createdAt: Date.now() };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * Acquire a concurrency slot.  Returns a resolve function; call it to release.
   * If slots are currently full, waits in a bounded FIFO queue.
   */
  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrency) {
      this.active++;
      return this.makeRelease();
    }

    return new Promise((resolve, reject) => {
      if (this.pendingQueue.length >= this.maxQueueDepth) {
        reject(new Error('Queue full'));
        return;
      }
      this.pendingQueue.push(() => {
        this.active++;
        resolve(this.makeRelease());
      });
    });
  }

  private makeRelease(): () => void {
    return () => {
      this.active--;
      const next = this.pendingQueue.shift();
      if (next) {
        // Yield to the event loop before promoting the next waiter so current
        // release finishes first.
        setImmediate(next);
      }
    };
  }

  /**
   * Run `work` under a concurrency slot, updating job status automatically.
   * `work` performs the dispatch to a worker and resolves with the artifact's
   * content type once the worker has persisted the result to Elasticsearch.
   */
  async run(job: Job, work: () => Promise<{ contentType: string }>): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await this.acquire();
      job.status = 'running';
      job.startedAt = Date.now();

      const { contentType } = await work();

      job.contentType = contentType;
      job.status = 'completed';
      job.completedAt = Date.now();
      this.totalCompleted++;
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();
      this.totalFailed++;
    } finally {
      release?.();
    }
  }
}
