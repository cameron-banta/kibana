/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiLoadingSpinner,
  EuiText,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { downloadFileAs } from '@kbn/share-plugin/public';
import { KbnDangerCallout } from '@kbn/ui-callout';
import type { Task } from '@kbn/task-runner-poc-plugin/common';
import type { RenderFile, TaskRunnerPocPublicStart } from '@kbn/task-runner-poc-plugin/public';

const POLL_INTERVAL_MS = 1500;
const FAILED = new Set<Task['status']>(['failed', 'timed_out', 'cancelled']);
// Long enough for the new tab to load the PDF from it.
const OPEN_URL_LIFETIME_MS = 60_000;

interface Run {
  task?: Task;
  file?: RenderFile;
  error?: string;
}

const done = ({ task, file, error }: Run) =>
  error !== undefined || file !== undefined || (task !== undefined && FAILED.has(task.status));

const message = (e: unknown) =>
  (e as { body?: { message?: string } })?.body?.message ??
  (e instanceof Error ? e.message : String(e));

const statusText = (task: Task | undefined) => {
  if (!task) {
    return i18n.translate('xpack.isomerDashboards.taskRunner.submitted', {
      defaultMessage: 'Submitted',
    });
  }
  const status = task.status === 'succeeded' ? 'reading the file' : task.status;
  return i18n.translate('xpack.isomerDashboards.taskRunner.status', {
    defaultMessage: 'Task {status}, execution {execution} of {maxExecutions}',
    values: { status, execution: task.execution, maxExecutions: task.maxExecutions },
  });
};

/** Follows a submitted `isomer_render` task until its PDF is in `tr-renders`, then offers the file. */
export const TaskRunnerRender = ({
  taskRunner,
  taskId,
}: {
  taskRunner: TaskRunnerPocPublicStart;
  taskId: string;
}) => {
  const [run, setRun] = useState<Run>({});

  useEffect(() => {
    if (done(run)) {
      return;
    }
    let current = true;
    const timer = setTimeout(
      async () => {
        try {
          const task = await taskRunner.getTask(taskId);
          const file = task.status === 'succeeded' ? await taskRunner.getRender(taskId) : undefined;
          if (current) {
            setRun({ task, ...(file ? { file } : {}) });
          }
        } catch (e) {
          if (current) {
            setRun((previous) => ({ ...previous, error: message(e) }));
          }
        }
      },
      run.task ? POLL_INTERVAL_MS : 0
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [taskRunner, taskId, run]);

  // Kibana's CSP allows neither a blob: frame nor an object, so the PDF opens in its own tab.
  const openPdf = (file: RenderFile) => {
    const url = URL.createObjectURL(file.blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), OPEN_URL_LIFETIME_MS);
  };

  const { task, file, error } = run;
  let content: React.ReactNode;
  if (error) {
    content = <KbnDangerCallout size="s" title={error} />;
  } else if (task && FAILED.has(task.status)) {
    content = (
      <KbnDangerCallout
        size="s"
        title={i18n.translate('xpack.isomerDashboards.taskRunner.failed', {
          defaultMessage: 'The render {status}',
          values: { status: task.status.replace('_', ' ') },
        })}
        text={task.error ?? undefined}
      />
    );
  } else if (file) {
    content = (
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiButton
            size="s"
            iconType="download"
            onClick={() => downloadFileAs(file.fileName, file.blob)}
            data-test-subj="isomerDashboardsTaskRunnerDownload"
          >
            {i18n.translate('xpack.isomerDashboards.taskRunner.download', {
              defaultMessage: 'Download PDF',
            })}
          </EuiButton>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiButtonEmpty
            size="s"
            iconType="external"
            onClick={() => openPdf(file)}
            data-test-subj="isomerDashboardsTaskRunnerOpen"
          >
            {i18n.translate('xpack.isomerDashboards.taskRunner.open', {
              defaultMessage: 'Open PDF',
            })}
          </EuiButtonEmpty>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="xs" color="subdued">
            {i18n.translate('xpack.isomerDashboards.taskRunner.drawn', {
              defaultMessage: '{size} KB, drawn by an isomer worker in {ms} ms',
              values: {
                size: Math.max(1, Math.round(file.blob.size / 1024)),
                ms: task?.result?.renderMs ?? '?',
              },
            })}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  } else {
    content = (
      <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiLoadingSpinner size="m" />
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiText size="s" data-test-subj="isomerDashboardsTaskRunnerStatus">
            {statusText(task)}
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    );
  }

  return (
    <EuiFormRow
      fullWidth
      label={i18n.translate('xpack.isomerDashboards.taskRunner.label', {
        defaultMessage: 'Task runner render ({taskId})',
        values: { taskId },
      })}
    >
      <div>{content}</div>
    </EuiFormRow>
  );
};
