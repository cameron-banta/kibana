/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { CoreSetup, Plugin } from '@kbn/core/public';
import type { ExportShareDerivatives, SharePluginSetup } from '@kbn/share-plugin/public';
import type { TaskRunnerPocPublicStart } from '@kbn/task-runner-poc-plugin/public';

interface SetupDeps {
  share: SharePluginSetup;
}

interface StartDeps {
  /** Present when the task runner POC is enabled; the flyout then offers to render there. */
  taskRunnerPoc?: TaskRunnerPocPublicStart;
}

// Dashboard's export menu labels an integration it doesn't know by its id.
export const ISOMER_EXPORT_ID = 'PDF (Isomer)';

export class IsomerDashboardsPublicPlugin implements Plugin<{}, {}, SetupDeps, StartDeps> {
  setup(core: CoreSetup<StartDeps>, { share }: SetupDeps) {
    share.registerShareIntegration<ExportShareDerivatives>('dashboard', {
      id: ISOMER_EXPORT_ID,
      groupId: 'exportDerivatives',
      getShareIntegrationConfig: async () => {
        const [[coreStart, { taskRunnerPoc }], { isomerExportConfig }] = await Promise.all([
          core.getStartServices(),
          import('./export_config'),
        ]);
        return isomerExportConfig(coreStart, taskRunnerPoc);
      },
    });
    return {};
  }

  start() {
    return {};
  }
}
