/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isNotFoundError } from '@kbn/es-errors';
import {
  API_PRIVILEGES,
  INTERNAL_API_BASE_PATH,
  INTERNAL_API_VERSION,
  RENDER_INDEX,
  RESULT_INDEX,
} from '../../common';
import type { ResultDocument } from '../../common';
import { errorToResponse } from '../errors';
import { limitQuerySchema, taskIdParamsSchema } from './schemas';
import type { RouteDependencies } from './types';

export const registerTaskRoutes = ({ router, serviceClient }: RouteDependencies) => {
  router.versioned
    .get({
      path: `${INTERNAL_API_BASE_PATH}/tasks`,
      access: 'internal',
      summary: "List the project's recent tasks",
      security: { authz: { requiredPrivileges: [API_PRIVILEGES.read] } },
    })
    .addVersion(
      { version: INTERNAL_API_VERSION, validate: { request: { query: limitQuerySchema } } },
      async (_context, request, response) => {
        try {
          return response.ok({ body: await serviceClient.listTasks(request.query.limit) });
        } catch (error) {
          return errorToResponse(response, error);
        }
      }
    );

  router.versioned
    .get({
      path: `${INTERNAL_API_BASE_PATH}/tasks/{taskId}`,
      access: 'internal',
      summary: 'Get one task with its executions',
      security: { authz: { requiredPrivileges: [API_PRIVILEGES.read] } },
    })
    .addVersion(
      { version: INTERNAL_API_VERSION, validate: { request: { params: taskIdParamsSchema } } },
      async (_context, request, response) => {
        try {
          return response.ok({ body: await serviceClient.getTask(request.params.taskId) });
        } catch (error) {
          return errorToResponse(response, error);
        }
      }
    );

  router.versioned
    .get({
      path: `${INTERNAL_API_BASE_PATH}/tasks/{taskId}/output`,
      access: 'internal',
      summary: "Read a task's output document from tr-results as the current user",
      security: { authz: { requiredPrivileges: [API_PRIVILEGES.read] } },
    })
    .addVersion(
      { version: INTERNAL_API_VERSION, validate: { request: { params: taskIdParamsSchema } } },
      async (context, request, response) => {
        const { taskId } = request.params;
        const esClient = (await context.core).elasticsearch.client.asCurrentUser;
        try {
          const doc = await esClient.get<ResultDocument>({ index: RESULT_INDEX, id: taskId });
          if (!doc.found || !doc._source) {
            return response.notFound({ body: { message: `No output for task ${taskId}` } });
          }
          return response.ok({ body: doc._source });
        } catch (error) {
          if (isNotFoundError(error)) {
            return response.notFound({
              body: { message: `No output for task ${taskId} in ${RESULT_INDEX}` },
            });
          }
          return errorToResponse(response, error);
        }
      }
    );

  router.versioned
    .get({
      path: `${INTERNAL_API_BASE_PATH}/tasks/{taskId}/render`,
      access: 'internal',
      summary: "Download an isomer_render task's file from tr-renders as the current user",
      security: { authz: { requiredPrivileges: [API_PRIVILEGES.read] } },
    })
    .addVersion(
      { version: INTERNAL_API_VERSION, validate: { request: { params: taskIdParamsSchema } } },
      async (context, request, response) => {
        const { taskId } = request.params;
        const esClient = (await context.core).elasticsearch.client.asCurrentUser;
        try {
          const doc = await esClient.get<RenderDocument>({ index: RENDER_INDEX, id: taskId });
          if (!doc.found || !doc._source?.content) {
            return response.notFound({ body: { message: `No render for task ${taskId}` } });
          }
          const { content, format, title } = doc._source;
          // Any task's API key can write tr-renders, so the stored contentType isn't trusted.
          const contentType = RENDER_CONTENT_TYPES.get(format);
          if (!contentType) {
            return response.notFound({ body: { message: `No render for task ${taskId}` } });
          }
          return response.ok({
            body: Buffer.from(content, 'base64'),
            headers: {
              'content-type': contentType,
              'content-disposition': `attachment; filename="${fileName(title, format)}"`,
            },
          });
        } catch (error) {
          if (isNotFoundError(error)) {
            return response.notFound({
              body: { message: `No render for task ${taskId} in ${RENDER_INDEX}` },
            });
          }
          return errorToResponse(response, error);
        }
      }
    );
};

/** The fields of a `tr-renders` document the download reads. */
interface RenderDocument {
  content: string;
  format: string;
  title?: string;
}

const RENDER_CONTENT_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
]);

const fileName = (title: string | undefined, format: string) =>
  `${
    (title ?? '')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'render'
  }.${format}`;
