/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Tracks the pool of render workers behind the API service and picks the
 * least-busy one for each dispatch. The POC typically runs a single worker,
 * but this keeps the routing logic honest for N workers.
 *
 * Global admission control (concurrency + bounded queue + 429) lives in the
 * RenderQueue; this class only decides *which* worker a slot's work goes to.
 */
export class WorkerPool {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly urls: string[]) {
    if (urls.length === 0) {
      throw new Error('WorkerPool requires at least one worker URL');
    }
    urls.forEach((url) => this.inFlight.set(url, 0));
  }

  /** Pick the worker with the fewest in-flight renders. */
  pick(): string {
    let best = this.urls[0];
    let min = Number.POSITIVE_INFINITY;
    for (const url of this.urls) {
      const n = this.inFlight.get(url) ?? 0;
      if (n < min) {
        min = n;
        best = url;
      }
    }
    return best;
  }

  markBusy(url: string): void {
    this.inFlight.set(url, (this.inFlight.get(url) ?? 0) + 1);
  }

  markFree(url: string): void {
    this.inFlight.set(url, Math.max(0, (this.inFlight.get(url) ?? 0) - 1));
  }

  snapshot(): Array<{ url: string; inFlight: number }> {
    return this.urls.map((url) => ({ url, inFlight: this.inFlight.get(url) ?? 0 }));
  }
}
