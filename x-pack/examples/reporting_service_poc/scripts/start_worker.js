/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Reporting worker launcher (Layer 3 — the render worker).
 *
 * Owns Chromium and the render pipeline. Receives render requests from the API
 * service (scripts/start_service.js), renders the artifact, and writes the bytes
 * straight to Elasticsearch under the job id. Run one or more of these; the API
 * service load-balances across them.
 *
 * Usage:
 *   node x-pack/examples/reporting_service_poc/scripts/start_worker.js [options]
 *
 * Options (all optional; env vars in parentheses):
 *   --port <n>          Port to listen on. Default: 8791. (REPORTING_WORKER_PORT)
 *   --kibana-url <url>  Kibana URL (used to build the screenshot-app URL stub).
 *                       Default: http://localhost:5601. (KIBANA_URL)
 *   --es-url <url>      Elasticsearch URL for writing results. Default: http://localhost:9200.
 *   --result-index <n>  ES index results are written to. Default: reporting-service-poc-results.
 *   --es-username <u>   Fallback ES basic-auth username. Default: elastic.
 *   --es-password <p>   Fallback ES basic-auth password. Default: changeme.
 *
 * The worker reuses the Authorization header forwarded by the API service to
 * write to ES; the --es-username/--es-password fallback is used to create the
 * result index at startup and when a request carries no auth.
 */

require('@kbn/setup-node-env');

const { initRenderPipeline } = require('../service/render_pipeline');
const { createWorkerServer } = require('../service/worker_server');
const { ensureResultIndex } = require('../service/es_client');

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    port: parseInt(get('--port') ?? process.env.REPORTING_WORKER_PORT ?? '8791', 10),
    kibanaUrl: get('--kibana-url') ?? process.env.KIBANA_URL ?? 'http://localhost:5601',
    esUrl: (get('--es-url') ?? 'http://localhost:9200').replace(/\/$/, ''),
    resultIndex: get('--result-index') ?? 'reporting-service-poc-results',
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
  console.info('║   Multi-tenant Reporting Service POC — render worker     ║');
  console.info('╚══════════════════════════════════════════════════════════╝');
  console.info('');
  console.info(`  Port:          ${opts.port}`);
  console.info(`  Kibana URL:    ${opts.kibanaUrl}`);
  console.info(`  Elasticsearch: ${opts.esUrl}`);
  console.info(`  Result index:  ${opts.resultIndex}`);
  console.info('');
  console.info('Initialising render pipeline (Chromium) …');

  await initRenderPipeline(opts.kibanaUrl);

  console.info('Ensuring result index exists …');
  await ensureResultIndex({
    esUrl: opts.esUrl,
    index: opts.resultIndex,
    authorization: fallbackEsAuthorization,
  });

  const server = createWorkerServer({ fallbackEsAuthorization });

  await new Promise((resolve, reject) => {
    server.listen(opts.port, '127.0.0.1', () => resolve(undefined));
    server.on('error', reject);
  });

  console.info('');
  console.info(`✓ Reporting worker listening on http://127.0.0.1:${opts.port}`);
  console.info('  Render endpoint: POST http://127.0.0.1:' + opts.port + '/api/v1/render');
  console.info('  Metrics:         GET  http://127.0.0.1:' + opts.port + '/api/v1/metrics');
  console.info('  Health:          GET  http://127.0.0.1:' + opts.port + '/api/v1/health');
  console.info('');
  console.info('Ready. Waiting for render dispatches from the API service …');

  const shutdown = () => {
    console.info('\nShutting down worker …');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting worker:', err);
  process.exit(1);
});
