/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  CoreSetup,
  CoreStart,
  Logger,
  Plugin,
  PluginInitializerContext,
} from '@kbn/core/server';
import type { FeaturesPluginSetup } from '@kbn/features-plugin/server';
import type { TaskRunnerPocConfig } from './config';
import { registerFeature } from './features';
import { createIsomerRenderSubmitter } from './isomer_render';
import type { TaskRunnerPocServerStart } from './isomer_render';
import { registerRoutes } from './routes';
import { TaskRunnerServiceClient } from './service_client';

export interface TaskRunnerPocSetupDependencies {
  features: FeaturesPluginSetup;
}

export class TaskRunnerPocPlugin
  implements Plugin<void, TaskRunnerPocServerStart, TaskRunnerPocSetupDependencies>
{
  private readonly config: TaskRunnerPocConfig;
  private readonly logger: Logger;
  private readonly serviceClient: TaskRunnerServiceClient;

  constructor(initializerContext: PluginInitializerContext<TaskRunnerPocConfig>) {
    this.config = initializerContext.config.get();
    this.logger = initializerContext.logger.get();
    this.serviceClient = new TaskRunnerServiceClient(this.config);
  }

  public setup(core: CoreSetup, { features }: TaskRunnerPocSetupDependencies) {
    const { serviceUrl, projectId, sharedSecret } = this.config;
    this.logger.info(
      `Task runner service ${serviceUrl}, project ${projectId}${
        sharedSecret ? '' : ' (sharedSecret is not set; service calls will fail)'
      }`
    );

    registerFeature(features);
    registerRoutes({
      router: core.http.createRouter(),
      logger: this.logger,
      projectId,
      serviceClient: this.serviceClient,
      getApiKeys: async () => {
        const [coreStart] = await core.getStartServices();
        return coreStart.security.authc.apiKeys;
      },
    });
  }

  public start(core: CoreStart): TaskRunnerPocServerStart {
    return {
      submitIsomerRender: createIsomerRenderSubmitter({
        apiKeys: core.security.authc.apiKeys,
        elasticsearch: core.elasticsearch,
        serviceClient: this.serviceClient,
        projectId: this.config.projectId,
        logger: this.logger,
      }),
    };
  }

  public stop() {}
}
