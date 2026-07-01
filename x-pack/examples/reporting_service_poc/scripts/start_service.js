/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Reporting Service launcher (Window 3 in the 3-window POC run).
 *
 * Usage:
 *   node x-pack/examples/reporting_service_poc/scripts/start_service.js [options]
 *
 * Options (all optional; can also use env vars):
 *   --port <n>           Port to listen on. Default: 8790. Env: REPORTING_SERVICE_PORT
 *   --kibana-url <url>   Kibana URL (needed for the screenshot-app URL stub).
 *                        Default: http://localhost:5601. Env: KIBANA_URL
 *   --concurrency <n>    Max parallel renders. Default: 2.
 *   --queue-depth <n>    Max queued requests before 429. Default: 10.
 *
 * Must be run from the Kibana repo root, e.g.:
 *   node x-pack/examples/reporting_service_poc/scripts/start_service.js
 */

// Bootstrap Kibana's TypeScript/path-alias transpiler so we can require() .ts files.
require('@kbn/setup-node-env');

const { initRenderPipeline } = require('../service/render_pipeline');
const { RenderQueue } = require('../service/queue');
const { createServer } = require('../service/server');

// ── Parse CLI args ────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    port: parseInt(get('--port') ?? process.env.REPORTING_SERVICE_PORT ?? '8790', 10),
    kibanaUrl: get('--kibana-url') ?? process.env.KIBANA_URL ?? 'http://localhost:5601',
    concurrency: parseInt(get('--concurrency') ?? '2', 10),
    queueDepth: parseInt(get('--queue-depth') ?? '10', 10),
  };
}

async function main() {
  const { port, kibanaUrl, concurrency, queueDepth } = parseArgs();

  console.info('');
  console.info('╔══════════════════════════════════════════════════════════╗');
  console.info('║   Multi-tenant Reporting Service POC                     ║');
  console.info('║   Mike Cote proposal — standalone HTTP service           ║');
  console.info('╚══════════════════════════════════════════════════════════╝');
  console.info('');
  console.info(`  Kibana URL:      ${kibanaUrl}`);
  console.info(`  Port:            ${port}`);
  console.info(`  Max concurrency: ${concurrency}`);
  console.info(`  Queue depth:     ${queueDepth}`);
  console.info('');
  console.info('Initialising render pipeline (Chromium) …');

  await initRenderPipeline(kibanaUrl);

  const queue = new RenderQueue(concurrency, queueDepth);
  const server = createServer(queue);

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(undefined));
    server.on('error', reject);
  });

  console.info('');
  console.info(`✓ Reporting service listening on http://127.0.0.1:${port}`);
  console.info('');
  console.info('  Sync endpoint:  POST http://127.0.0.1:' + port + '/api/v1/screenshot');
  console.info('  Async submit:   POST http://127.0.0.1:' + port + '/api/v1/jobs');
  console.info('  Status poll:    GET  http://127.0.0.1:' + port + '/api/v1/jobs/:id');
  console.info('  Artifact:       GET  http://127.0.0.1:' + port + '/api/v1/jobs/:id/artifact');
  console.info('  Health:         GET  http://127.0.0.1:' + port + '/api/v1/health');
  console.info('');
  console.info('Ready. Waiting for render requests from Kibana …');

  // Graceful shutdown
  const shutdown = () => {
    console.info('\nShutting down reporting service …');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting reporting service:', err);
  process.exit(1);
});
