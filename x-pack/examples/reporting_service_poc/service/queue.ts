/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Simple in-process concurrency queue.
 *
 * Limits how many renders run simultaneously. When the active-render count equals
 * maxConcurrency and the bounded queue is full, further requests receive 429.
 *
 * This demonstrates the admission-control + backpressure contract Mike's doc
 * describes: the service returns 429 + Retry-After when at capacity, and Kibana
 * (Task Manager) backs off and retries.
 */

import crypto from 'crypto';
import type { Job } from './types';

export class RenderQueue {
  private active = 0;
  private jobs = new Map<string, Job>();
  private pendingQueue: Array<() => void> = [];

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

  /** Convenience: run work under a concurrency slot, updating job status automatically. */
  async run(job: Job, work: () => Promise<Buffer>): Promise<void> {
    let release: (() => void) | undefined;
    try {
      release = await this.acquire();
      job.status = 'running';
      job.startedAt = Date.now();

      const data = await work();

      job.resultBase64 = data.toString('base64');
      job.status = 'completed';
      job.completedAt = Date.now();
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.completedAt = Date.now();
    } finally {
      release?.();
    }
  }
}
