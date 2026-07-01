/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Plugin, CoreSetup, CoreStart } from '@kbn/core/server';

/**
 * Near no-op runtime plugin. The real value of this example package is
 * `scripts/start_service.js` (the standalone reporting service) and the docs/.
 *
 * Load with: yarn start --run-examples
 */
export class ReportingServicePocPlugin implements Plugin<void, void> {
  setup(_core: CoreSetup): void {}
  start(_core: CoreStart): void {}
  stop(): void {}
}
