/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { HttpSetup } from '@kbn/core/public';
import { INTERNAL_API_BASE_PATH, INTERNAL_API_VERSION } from '../common';
import type {
  CreateJobBody,
  CreateJobResponse,
  JobList,
  ResultDocument,
  Task,
  TaskList,
} from '../common';

const LIST_LIMIT = 50;
const JOB_TASKS_LIMIT = 10;

export interface RenderFile {
  fileName: string;
  blob: Blob;
}

export interface TaskRunnerApi {
  createJob(body: CreateJobBody): Promise<CreateJobResponse>;
  listJobs(): Promise<JobList>;
  deleteJob(jobId: string): Promise<void>;
  listJobTasks(jobId: string): Promise<TaskList>;
  listTasks(): Promise<TaskList>;
  getTask(taskId: string): Promise<Task>;
  getTaskOutput(taskId: string): Promise<ResultDocument>;
  /** An `isomer_render` task's file; fetched, since a plain link can't send the internal API's headers. */
  getRender(taskId: string): Promise<RenderFile>;
}

const fileNameFrom = (contentDisposition: string | null, fallback: string) =>
  contentDisposition?.match(/filename="([^"]+)"/)?.[1] ?? fallback;

export const createApi = (http: HttpSetup): TaskRunnerApi => {
  const version = INTERNAL_API_VERSION;
  const path = (suffix: string) => `${INTERNAL_API_BASE_PATH}${suffix}`;

  return {
    createJob: (body) => http.post(path('/jobs'), { version, body: JSON.stringify(body) }),
    listJobs: () => http.get(path('/jobs'), { version, query: { limit: LIST_LIMIT } }),
    deleteJob: (jobId) => http.delete(path(`/jobs/${encodeURIComponent(jobId)}`), { version }),
    listJobTasks: (jobId) =>
      http.get(path(`/jobs/${encodeURIComponent(jobId)}/tasks`), {
        version,
        query: { limit: JOB_TASKS_LIMIT },
      }),
    listTasks: () => http.get(path('/tasks'), { version, query: { limit: LIST_LIMIT } }),
    getTask: (taskId) => http.get(path(`/tasks/${encodeURIComponent(taskId)}`), { version }),
    getTaskOutput: (taskId) =>
      http.get(path(`/tasks/${encodeURIComponent(taskId)}/output`), { version }),
    getRender: async (taskId) => {
      const { response } = await http.get(path(`/tasks/${encodeURIComponent(taskId)}/render`), {
        version,
        asResponse: true,
        rawResponse: true,
      });
      if (!response) {
        throw new Error(`The render of task ${taskId} didn't download`);
      }
      return {
        fileName: fileNameFrom(response.headers.get('content-disposition'), 'render'),
        blob: await response.blob(),
      };
    },
  };
};

/** The message from a Kibana error response, or from any other error. */
export const errorMessage = (error: unknown): string => {
  const body = (error as { body?: { message?: string } })?.body;
  if (body?.message) {
    return body.message;
  }
  return error instanceof Error ? error.message : String(error);
};
