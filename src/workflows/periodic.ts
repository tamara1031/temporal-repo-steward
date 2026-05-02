import {
  executeChild,
  workflowInfo,
  log,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
} from '@temporalio/workflow';
import { cheap, heavy } from './proxies';
import { robustPRMergeWorkflow } from './pr-lifecycle';
import { buildRefactorPrompt } from './refactor-prompt';

export interface PeriodicRefactorInput {
  repoFullName: string;
  baseBranch?: string;
  refactorBrief?: string;
  /** When false, the child PR-lifecycle stops before merging. Defaults to true. */
  autoMerge?: boolean;
}

export interface PeriodicRefactorOutput {
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  skipped?: 'no-changes';
}

/**
 * periodicRefactorWorkflow — runs on a Temporal Schedule.
 * Clones the repo, asks codex to identify and apply narrow refactors, then
 * hands the resulting branch off to the common PR-lifecycle child workflow.
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
    const result = await heavy.codexActivity({
      workdir: clone.workdir,
      prompt: buildRefactorPrompt(input.refactorBrief),
    });

    if (result.changedFiles.length === 0) {
      log.info('No changes after refactor pass; skipping PR');
      return { skipped: 'no-changes' };
    }

    await heavy.commitAllActivity({
      workdir: clone.workdir,
      message: `refactor(auto): ${branch}`,
    });

    const prResult = await executeChild(robustPRMergeWorkflow, {
      args: [
        {
          repoFullName: input.repoFullName,
          workdir: clone.workdir,
          branch,
          baseBranch,
          prTitle: 'refactor(auto): periodic agent pass',
          prBody:
            'Automated refactor pass.\n\n' +
            '### Codex summary\n```\n' +
            result.message.slice(0, 4000) +
            '\n```\n\n' +
            '### Changed files\n' +
            result.changedFiles.map((f: string) => ` - ${f}`).join('\n'),
          autoMerge: input.autoMerge,
        },
      ],
      workflowId: `pr-lifecycle-${branch}`,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });

    return { prUrl: prResult.prUrl, prNumber: prResult.prNumber, merged: prResult.merged };
  } finally {
    await cheap.cleanupWorkspaceActivity({ workdir: clone.workdir }).catch(() => undefined);
  }
}
