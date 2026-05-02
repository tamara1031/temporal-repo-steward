import {
  proxyActivities,
  executeChild,
  startChild,
  workflowInfo,
  log,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../activities';
import { robustPRMergeWorkflow } from './shared/pr_lifecycle';

const cheap = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
    nonRetryableErrorTypes: ['MissingCredentials'],
  },
});

const heavy = proxyActivities<typeof activities>({
  startToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 4,
    nonRetryableErrorTypes: ['MissingCredentials'],
  },
});

export interface IssueDrivenInput {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  baseBranch?: string;
}

export interface IssueDrivenOutput {
  prUrl?: string;
  prNumber?: number;
  status: 'done' | 'failed' | 'no-changes';
}

/**
 * issueDrivenWorkflow — one workflow per `ai-ready` issue.
 * Lifecycle:
 *   started -> clone -> codex context -> claude implementation -> commit
 *   pr_created -> child PR-lifecycle workflow -> merge
 *   done (or failed)
 */
export async function issueDrivenWorkflow(input: IssueDrivenInput): Promise<IssueDrivenOutput> {
  const baseBranch = input.baseBranch ?? 'main';
  const info = workflowInfo();
  const branch = `agent/issue-${input.issueNumber}-${info.workflowId.slice(-8)}`;

  await cheap.updateIssueStatusActivity({
    repoFullName: input.repoFullName,
    number: input.issueNumber,
    status: 'started',
    note: `Agent worker starting work — workflow ${info.workflowId}.`,
  });

  let workdir: string | undefined;
  try {
    const clone = await heavy.cloneRepoActivity({
      repoFullName: input.repoFullName,
      branch,
      ref: baseBranch,
    });
    workdir = clone.workdir;

    const context = await heavy.codexAnalyzeActivity({
      workdir: clone.workdir,
      prompt:
        `Locate the code most relevant to GitHub issue #${input.issueNumber}.\n` +
        `Title: ${input.issueTitle}\n\n` +
        `Body:\n${input.issueBody}\n\n` +
        'Return: (1) the files & functions to touch, (2) constraints from neighboring code, ' +
        '(3) a concrete implementation plan.',
    });

    const result = await heavy.runClaudeActivity({
      workdir: clone.workdir,
      systemPrompt:
        'You implement GitHub issues end-to-end. Follow the plan from the analysis exactly. ' +
        'Add tests where the project has tests. Keep diffs focused.',
      context: context.summary,
      prompt:
        `Implement issue #${input.issueNumber} (${input.issueUrl}) according to the plan above. ` +
        'Edit files in place; do not create unrelated files.',
    });

    if (result.changedFiles.length === 0) {
      log.warn('No changes produced for issue', { issue: input.issueNumber });
      await cheap.updateIssueStatusActivity({
        repoFullName: input.repoFullName,
        number: input.issueNumber,
        status: 'failed',
        note: 'Agent ran but produced no diff. Manual triage required.',
      });
      return { status: 'no-changes' };
    }

    await heavy.commitAllActivity({
      workdir: clone.workdir,
      message: `feat(#${input.issueNumber}): ${input.issueTitle}`,
    });

    await cheap.updateIssueStatusActivity({
      repoFullName: input.repoFullName,
      number: input.issueNumber,
      status: 'pr_created',
    });

    const prResult = await executeChild(robustPRMergeWorkflow, {
      args: [
        {
          repoFullName: input.repoFullName,
          workdir: clone.workdir,
          branch,
          baseBranch,
          prTitle: `feat(#${input.issueNumber}): ${input.issueTitle}`,
          prBody:
            `Closes #${input.issueNumber}\n\n` +
            '### Codex context\n```\n' +
            context.summary.slice(0, 4000) +
            '\n```\n\n' +
            '### Claude implementation\n```\n' +
            result.message.slice(0, 4000) +
            '\n```',
        },
      ],
      workflowId: `pr-lifecycle-issue-${input.issueNumber}-${info.workflowId.slice(-8)}`,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });

    await cheap.updateIssueStatusActivity({
      repoFullName: input.repoFullName,
      number: input.issueNumber,
      status: 'done',
      note: `Merged via ${prResult.prUrl}`,
    });

    return { status: 'done', prNumber: prResult.prNumber, prUrl: prResult.prUrl };
  } catch (err) {
    log.error('issueDrivenWorkflow failed', { err: String(err) });
    await cheap
      .updateIssueStatusActivity({
        repoFullName: input.repoFullName,
        number: input.issueNumber,
        status: 'failed',
        note: `Workflow failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => undefined);
    if (err instanceof ApplicationFailure) throw err;
    throw err;
  } finally {
    if (workdir) {
      await cheap.cleanupWorkspaceActivity({ workdir }).catch(() => undefined);
    }
  }
}

/**
 * issuePollerWorkflow — periodic poll that fans out one issueDrivenWorkflow per
 * unprocessed `ai-ready` issue. Exits after dispatch so a Temporal Schedule
 * can re-trigger it.
 */
export interface IssuePollerInput {
  repoFullName: string;
  baseBranch?: string;
  taskQueue: string;
}

export interface IssuePollerOutput {
  dispatched: number;
  workflowIds: string[];
}

export async function issuePollerWorkflow(input: IssuePollerInput): Promise<IssuePollerOutput> {
  const pollerInfo = workflowInfo();
  const issues = await cheap.listAiReadyIssuesActivity({
    repoFullName: input.repoFullName,
  });
  const dispatched: string[] = [];
  for (const issue of issues) {
    const wfId =
      `issue-driven-${input.repoFullName.replace('/', '__')}-${issue.number}` +
      `-${pollerInfo.workflowId.slice(-8)}`;
    try {
      // startChild returns once the child has been started; we do NOT await its result.
      await startChild(issueDrivenWorkflow, {
        args: [
          {
            repoFullName: issue.repoFullName,
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueBody: issue.body,
            issueUrl: issue.url,
            baseBranch: input.baseBranch,
          },
        ],
        workflowId: wfId,
        taskQueue: input.taskQueue,
        parentClosePolicy: ParentClosePolicy.ABANDON,
        cancellationType: ChildWorkflowCancellationType.ABANDON,
      });
      dispatched.push(wfId);
    } catch (err) {
      log.warn('Failed to start issue-driven child', { issue: issue.number, err: String(err) });
    }
  }
  return { dispatched: dispatched.length, workflowIds: dispatched };
}
