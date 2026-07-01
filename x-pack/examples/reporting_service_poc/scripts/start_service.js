/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Reporting API service launcher (Layer 2 — the router tier).
 *
 * This process does NOT run Chromium. It accepts render requests from Kibana,
 * applies admission control (concurrency + bounded queue + 429), routes each
 * accepted render to a worker over HTTP, exposes /metrics for autoscaling, and
 * reads finished artifacts back from Elasticsearch to serve downloads.
 *
 * Start a worker separately with scripts/start_worker.js.
 *
 * Usage:
 *   node x-pack/examples/reporting_service_poc/scripts/start_service.js [options]
 *
 * Options (all optional; env vars in parentheses):
 *   --port <n>          Port to listen on. Default: 8790. (REPORTING_SERVICE_PORT)
 *   --worker-url <url>  Worker base URL(s), comma-separated. Default: http://127.0.0.1:8791.
 *   --es-url <url>      Elasticsearch URL for reading results. Default: http://localhost:9200.
 *   --result-index <n>  ES index results are stored in. Default: reporting-service-poc-results.
 *   --concurrency <n>   Max parallel renders (should match total worker capacity). Default: 1.
 *   --queue-depth <n>   Max queued requests before 429. Default: 10.
 *   --es-username <u>   Fallback ES basic-auth username. Default: elastic.
 *   --es-password <p>   Fallback ES basic-auth password. Default: changeme.
 *
 * Auth: Kibana calls this service with `Authorization: ApiKey <key>` when
 * `xpack.screenshotting.service.apiKey` is set; that header is forwarded to the
 * worker (reused for the ES write) and used here for ES reads. When absent, the
 * --es-username/--es-password basic-auth fallback is used so the POC runs locally.
 */

require('@kbn/setup-node-env');

const { RenderQueue } = require('../service/queue');
const { WorkerPool } = require('../service/worker_pool');
const { createServer } = require('../service/server');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    port: parseInt(get('--port') ?? process.env.REPORTING_SERVICE_PORT ?? '8790', 10),
    workerUrls: (get('--worker-url') ?? 'http://127.0.0.1:8791')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    esUrl: (get('--es-url') ?? 'http://localhost:9200').replace(/\/$/, ''),
    resultIndex: get('--result-index') ?? 'reporting-service-poc-results',
    concurrency: parseInt(get('--concurrency') ?? '1', 10),
    queueDepth: parseInt(get('--queue-depth') ?? '10', 10),
    esUsername: get('--es-username') ?? 'elastic',
    esPassword: get('--es-password') ?? 'changeme',
  };
}

async function main() {
  const opts = parseArgs();
  const fallbackEsAuthorization =
    'Basic ' + Buffer.from(`${opts.esUsername}:${opts.esPassword}`).toString('base64');

  console.info('');
  console.info('╔══════════════════════════════════════════════════════════╗');
  console.info('║   Multi-tenant Reporting Service POC — API / router tier ║');
  console.info('╚══════════════════════════════════════════════════════════╝');
  console.info('');
  console.info(`  Port:            ${opts.port}`);
  console.info(`  Worker(s):       ${opts.workerUrls.join(', ')}`);
  console.info(`  Elasticsearch:   ${opts.esUrl}`);
  console.info(`  Result index:    ${opts.resultIndex}`);
  console.info(`  Max concurrency: ${opts.concurrency}`);
  console.info(`  Queue depth:     ${opts.queueDepth}`);
  console.info('');

  const queue = new RenderQueue(opts.concurrency, opts.queueDepth);
  const pool = new WorkerPool(opts.workerUrls);
  const server = createServer(queue, pool, {
    esUrl: opts.esUrl,
    resultIndex: opts.resultIndex,
    fallbackEsAuthorization,
  });

  await new Promise((resolve, reject) => {
    server.listen(opts.port, '127.0.0.1', () => resolve(undefined));
    server.on('error', reject);
  });

  console.info(`✓ Reporting API service listening on http://127.0.0.1:${opts.port}`);
  console.info('');
  console.info('  Sync endpoint:  POST http://127.0.0.1:' + opts.port + '/api/v1/screenshot');
  console.info('  Async submit:   POST http://127.0.0.1:' + opts.port + '/api/v1/jobs');
  console.info('  Status poll:    GET  http://127.0.0.1:' + opts.port + '/api/v1/jobs/:id');
  console.info(
    '  Artifact:       GET  http://127.0.0.1:' + opts.port + '/api/v1/jobs/:id/artifact'
  );
  console.info('  Metrics:        GET  http://127.0.0.1:' + opts.port + '/api/v1/metrics');
  console.info('  Health:         GET  http://127.0.0.1:' + opts.port + '/api/v1/health');
  console.info('');
  console.info('Ready. Waiting for render requests from Kibana …');

  const shutdown = () => {
    console.info('\nShutting down API service …');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting API service:', err);
  process.exit(1);
});
