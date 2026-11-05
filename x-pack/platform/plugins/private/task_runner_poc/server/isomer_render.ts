/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  CoreAuthenticationService,
  ElasticsearchServiceStart,
  KibanaRequest,
  Logger,
} from '@kbn/core/server';
import { ISOMER_INPUT_INDEX, ISOMER_TASK_TYPE, RENDER_INDEX } from '../common';
import type { CreateJobResponse } from '../common';
import { grantTaskApiKey } from './api_keys';
import { getErrorMessage } from './errors';
import { identityMeta } from './log_meta';
import type { TaskRunnerLogMeta } from './log_meta';
import type { TaskRunnerServiceClient } from './service_client';

const RENDER_TIMEOUT = '120s';
const RENDER_MAX_EXECUTIONS = 2;

/** A lowered dashboard, as the Isomer render host draws it. */
export interface IsomerRenderInput {
  title: string;
  composition: unknown;
  /** The render host's draw options (`HostDrawOptions`); JSON, since a worker reads them. */
  options: Record<string, unknown>;
  format: 'png' | 'pdf';
}

export interface TaskRunnerPocServerStart {
  /**
   * Submits a one-shot `isomer_render` job for the request's user. The composition goes to
   * `tr-isomer-inputs` with the job's own API key, so the input is only as reachable as the task.
   */
  submitIsomerRender(request: KibanaRequest, input: IsomerRenderInput): Promise<CreateJobResponse>;
}

export const createIsomerRenderSubmitter =
  ({
    apiKeys,
    elasticsearch,
    serviceClient,
    projectId,
    logger,
  }: {
    apiKeys: CoreAuthenticationService['apiKeys'];
    elasticsearch: ElasticsearchServiceStart;
    serviceClient: TaskRunnerServiceClient;
    projectId: string;
    logger: Logger;
  }): TaskRunnerPocServerStart['submitIsomerRender'] =>
  async (request, { title, composition, options, format }) => {
    const idempotencyKey = `kbn-${uuidv4()}`;
    const inputId = uuidv4();
    try {
      const apiKey = await grantTaskApiKey(apiKeys, request, {
        name: 'task_runner_poc isomer render',
        expiration: '1h',
        metadata: { projectId, idempotencyKey },
      });
      await elasticsearch.client
        .asScoped({ headers: { authorization: `ApiKey ${apiKey.encoded}` } })
        .asCurrentUser.index({
          index: ISOMER_INPUT_INDEX,
          id: inputId,
          document: {
            '@timestamp': new Date().toISOString(),
            projectId,
            title,
            composition,
            options,
          },
        });
      const created = await serviceClient.createJob({
        taskType: ISOMER_TASK_TYPE,
        params: { inputIndex: ISOMER_INPUT_INDEX, inputId, resultIndex: RENDER_INDEX, format },
        apiKey: apiKey.encoded,
        timeout: RENDER_TIMEOUT,
        maxExecutions: RENDER_MAX_EXECUTIONS,
        idempotencyKey,
      });
      logger.info<TaskRunnerLogMeta>(
        `Created isomer_render job ${created.jobId} for "${title}" (input ${ISOMER_INPUT_INDEX}/${inputId})`,
        identityMeta(
          { projectId, jobId: created.jobId, taskId: created.taskId },
          { action: 'job-created', outcome: 'success' }
        )
      );
      return created;
    } catch (error) {
      logger.warn<TaskRunnerLogMeta>(
        `Failed to create isomer_render job: ${getErrorMessage(error)}`,
        identityMeta({ projectId }, { action: 'job-created', outcome: 'failure' })
      );
      throw error;
    }
  };
