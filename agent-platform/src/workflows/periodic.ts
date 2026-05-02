import {
  proxyActivities,
  executeChild,
  workflowInfo,
  log,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
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

export interface PeriodicRefactorInput {
  repoFullName: string;
  baseBranch?: string;
  refactorBrief?: string;
}

export interface PeriodicRefactorOutput {
  prUrl?: string;
  prNumber?: number;
  skipped?: 'no-changes';
}

/**
 * periodicRefactorWorkflow — runs on a Temporal Schedule.
 * Clones the repo, asks codex to map opportunities, asks claude to apply them,
 * and hands the resulting branch off to the common PR-lifecycle child workflow.
 */
export async function periodicRefactorWorkflow(
  input: PeriodicRefactorInput,
): Promise<PeriodicRefactorOutput> {
  const baseBranch = input.baseBranch ?? 'main';
  const info = workflowInfo();
  const branch = `agent/refactor/${info.workflowId}`;

  const clone = await heavy.cloneRepoActivity({
    repoFullName: input.repoFullName,
    branch,
    ref: baseBranch,
  });

  try {
    const analysis = await heavy.codexAnalyzeActivity({
      workdir: clone.workdir,
      prompt:
        'Survey this repository for safe, narrow refactors that improve clarity or remove ' +
        'duplication WITHOUT changing observable behavior. Pick at most 3 opportunities and ' +
        'output a concrete plan: file paths, exact edits, expected risk. ' +
        (input.refactorBrief ?? ''),
    });

    const claudeResult = await heavy.runClaudeActivity({
      workdir: clone.workdir,
      systemPrompt:
        'You are a careful refactoring engineer. Apply the plan precisely. ' +
        'Do not introduce new dependencies. Keep tests green.',
      context: analysis.summary,
      prompt: 'Apply the refactor plan to the working tree, then stop.',
    });

    if (claudeResult.changedFiles.length === 0) {
      log.info('No changes after refactor pass; skipping PR');
      return { skipped: 'no-changes' };
    }

    await heavy.commitAllActivity({
      workdir: clone.workdir,
      message: `refactor(auto): ${branch}`,
    });

    const result = await executeChild(robustPRMergeWorkflow, {
      args: [
        {
          repoFullName: input.repoFullName,
          workdir: clone.workdir,
          branch,
          baseBranch,
          prTitle: 'refactor(auto): periodic agent pass',
          prBody:
            'Automated refactor pass.\n\n' +
            '### Codex analysis\n```\n' +
            analysis.summary.slice(0, 4000) +
            '\n```\n\n' +
            '### Claude summary\n```\n' +
            claudeResult.message.slice(0, 4000) +
            '\n```',
        },
      ],
      workflowId: `pr-lifecycle-${branch}`,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });

    return { prUrl: result.prUrl, prNumber: result.prNumber };
  } finally {
    await cheap.cleanupWorkspaceActivity({ workdir: clone.workdir }).catch(() => undefined);
  }
}
