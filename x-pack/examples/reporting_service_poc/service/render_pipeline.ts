/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Render pipeline harness.
 *
 * Stubs the minimal Kibana-core dependencies required by Screenshots/HeadlessChromiumDriverFactory
 * and runs the real Kibana render pipeline against the service's own Chromium process.
 *
 * This proves the core thesis of Mike Cote's proposal: all render logic travels with Kibana (via
 * Kibana's own package), Chromium is isolated in the service. Productionising would extract the
 * render pipeline into a standalone, versioned npm package the service builds against.
 */

import path from 'path';
import { lastValueFrom } from 'rxjs';
import { ChromiumArchivePaths, createConfig, getChromiumPackage } from '@kbn/screenshotting-server';
import type { RenderRequest } from './types';

/** Minimal log helper — uses process.stdout/stderr (service is a standalone Node.js script). */
const svcLog = {
  info: (msg: string) => process.stdout.write(`[INFO][render-pipeline] ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`[WARN][render-pipeline] ${msg}\n`),
  error: (msg: string | Error) => process.stderr.write(`[ERROR][render-pipeline] ${String(msg)}\n`),
};

/**
 * Minimal stub for HttpServiceSetup.
 * getServerInfo() is only called for expression-type screenshots (not used by reporting).
 * basePath.serverBasePath is used to build the screenshotting app URL — also expression-only.
 */
function makeHttpStub(kibanaUrl: string) {
  const url = new URL(kibanaUrl);
  return {
    getServerInfo: () => ({
      protocol: url.protocol.replace(':', '') as 'http' | 'https',
      hostname: url.hostname,
      port: parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10),
      name: 'kibana',
      uuid: 'reporting-service-poc',
    }),
    basePath: {
      serverBasePath: url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname,
    },
  };
}

/** Minimal stub satisfying the PackageInfo used by the PDF footer generator. */
const packageInfoStub = {
  branch: 'reporting-service-poc',
  buildNum: 0,
  buildSha: '0000000000000000000000000000000000000000',
  buildShaShort: '0000000',
  version: '9.x.0-poc',
  buildDate: new Date().toISOString(),
  buildFlavor: 'traditional' as const,
};

/** Minimal Logger satisfying @kbn/core Logger interface, backed by process.stdout/stderr. */
// Return type is `any` because Logger lives in @kbn/logging which we intentionally don't
// import at the type-check layer of this standalone service (would require adding it to
// kbn_references and pulling in the full core dep graph into the example plugin tsconfig).

function makeKbnLogger(prefix: string): any {
  const fmt = (level: string, msg: string, meta?: unknown): string =>
    `[${level}][${prefix}] ${msg}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}\n`;
  const logger = {
    trace: (m: string, meta?: unknown) => process.stdout.write(fmt('TRACE', m, meta)),
    debug: (m: string, meta?: unknown) => process.stdout.write(fmt('DEBUG', m, meta)),
    info: (m: string, meta?: unknown) => process.stdout.write(fmt('INFO', m, meta)),
    warn: (m: string, meta?: unknown) => process.stderr.write(fmt('WARN', m, meta)),
    error: (m: string | Error, meta?: unknown) =>
      process.stderr.write(fmt('ERROR', String(m), meta)),
    fatal: (m: string | Error, meta?: unknown) =>
      process.stderr.write(fmt('FATAL', String(m), meta)),
    log: (record: unknown) => process.stdout.write(JSON.stringify(record) + '\n'),
    get: (childPrefix: string) => makeKbnLogger(`${prefix}.${childPrefix}`),
  };
  return logger;
}

let _screenshots: any | null = null;

/**
 * Initialise the render pipeline (downloads/verifies Chromium, creates Screenshots instance).
 * Must be called once at service startup before any render requests are handled.
 *
 * All Kibana render-pipeline modules are loaded here via dynamic import so that:
 *  1. They are transpiled by @kbn/setup-node-env before use.
 *  2. The top-level module remains loadable even before initRenderPipeline() is called.
 */
export async function initRenderPipeline(kibanaUrl: string): Promise<void> {
  const logger = makeKbnLogger('render-pipeline') as {
    info: (m: string) => void;
    get: (c: string) => unknown;
  };

  // Resolve paths relative to this file's location.
  // In production this would be: import('@kbn/screenshotting-render') — a published package.
  const repoRoot = path.resolve(__dirname, '../../../..');
  const screenshottingBase = `${repoRoot}/x-pack/platform/plugins/shared/screenshotting/server`;
  const commonBase = `${repoRoot}/src/platform/plugins/shared/screenshot_mode/common`;

  // Dynamic imports — transpiled by @kbn/babel-register; avoids top-level require() calls.

  const [{ Screenshots }, { HeadlessChromiumDriverFactory }, { install }, screenshotModeCommon] =
    (await Promise.all([
      import(`${screenshottingBase}/screenshots/screenshots`),
      import(`${screenshottingBase}/browsers/chromium/driver_factory`),
      import(`${screenshottingBase}/browsers/install`),
      // screenshotMode functions run inside the browser via page.evaluateOnNewDocument;
      // they must have no external references, so we load them separately from the common module.
      import(commonBase),
    ])) as any[];

  // screenshotMode stub — two pure browser functions injected before page navigation.
  const screenshotModeStub = {
    setScreenshotModeEnabled: screenshotModeCommon.setScreenshotModeEnabled,
    setScreenshotContext: screenshotModeCommon.setScreenshotContext,
    isScreenshotMode: () => false,
  };

  // The screenshotting plugin installs Chromium relative to its own install.ts file.
  // Reuse the binary already installed in the repo.
  const chromiumPath = path.join(
    repoRoot,
    'x-pack/platform/plugins/shared/screenshotting/chromium'
  );

  logger.info(`Locating / verifying Chromium binary …`);
  const binaryPath = await install(
    new ChromiumArchivePaths(),
    makeKbnLogger('chromium'),
    getChromiumPackage(),
    chromiumPath
  );
  logger.info(`Chromium binary: ${binaryPath}`);

  // Build a config compatible with the screenshotting plugin's expected shape.
  // createConfig() fills in dynamic defaults (e.g. disableSandbox based on OS).
  const config = await createConfig(makeKbnLogger('config'), {
    enabled: true,
    networkPolicy: {
      enabled: true,
      rules: [
        { allow: true, protocol: 'http:' },
        { allow: true, protocol: 'https:' },
        { allow: true, protocol: 'ws:' },
        { allow: true, protocol: 'wss:' },
        { allow: true, protocol: 'data:' },
        { allow: false },
      ],
    },
    browser: {
      autoDownload: false,
      chromium: { disableSandbox: undefined, proxy: { enabled: false } },
    },
    capture: {
      timeouts: {
        openUrl: 60_000,
        waitForElements: 60_000,
        renderComplete: 120_000,
      },
      zoom: 2,
    },
    poolSize: 1,
    service: { enabled: false, url: undefined, mode: 'async', apiKey: undefined },
  });

  const driverFactory = new HeadlessChromiumDriverFactory(
    screenshotModeStub,
    config,
    makeKbnLogger('chromium.driver'),
    binaryPath,
    '' // basePath — not used for URL-based requests
  );

  _screenshots = new Screenshots(
    driverFactory,
    makeKbnLogger('screenshots'),
    packageInfoStub,
    makeHttpStub(kibanaUrl),
    config
  );

  logger.info(`Render pipeline ready`);
}

/**
 * Run the Kibana render pipeline for a single request and return the artifact bytes.
 * This is the single point where all render logic lives — identical to what runs inside Kibana.
 */
export async function render(req: RenderRequest): Promise<Buffer> {
  if (!_screenshots) {
    throw new Error('Render pipeline not initialised — call initRenderPipeline() first');
  }

  const options: Record<string, unknown> = {
    format: req.format,
    browserTimezone: req.browserTimezone,
    layout: req.layout,
    urls: req.urls,
    headers: req.headers,
    title: req.title,
    logo: req.logo,
    taskInstanceFields: req.taskInstanceFields ?? {},
  };

  svcLog.info(`Starting render: format=${req.format} urls=${req.urls.length}`);

  const result = await lastValueFrom(_screenshots.getScreenshots(options as any));

  if (req.format === 'pdf') {
    return (result as any).data as Buffer;
  }

  // PNG — result is PngScreenshotResult (= CaptureResult)

  const results: Array<{ screenshots: Array<{ data: Buffer }> }> = (result as any).results;
  return results[0].screenshots[0].data;
}
