import {
  proxyActivities,
  log,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../../activities';

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

const ciWait = proxyActivities<typeof activities>({
  // Allow CI runs up to 1 hour per attempt; the activity polls and heartbeats.
  startToCloseTimeout: '70 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '15s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 3,
    nonRetryableErrorTypes: ['MissingCredentials'],
  },
});

export interface RobustPRMergeInput {
  repoFullName: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  prTitle: string;
  prBody: string;
  /** Hard cap on CI-fail / conflict iterations to prevent infinite loops. */
  maxFixIterations?: number;
}

export interface RobustPRMergeOutput {
  prNumber: number;
  prUrl: string;
  iterations: number;
}

/**
 * Common PR lifecycle:
 *   1. createPRActivity
 *   2. CI monitor loop — on failure: pull failed logs, codex re-context, claude fix, push, retry.
 *   3. Conflict resolution loop — on conflict: codex digest, claude resolve, push, return to CI loop.
 *   4. mergePRActivity.
 */
export async function robustPRMergeWorkflow(
  input: RobustPRMergeInput,
): Promise<RobustPRMergeOutput> {
  const maxIters = input.maxFixIterations ?? 8;
  const info = workflowInfo();

  // 1. Push the initial branch (fresh PR) and create the PR.
  await heavy.pushBranchActivity({
    workdir: input.workdir,
    branch: input.branch,
    setUpstream: true,
  });

  const pr = await cheap.createPRActivity({
    repoFullName: input.repoFullName,
    workdir: input.workdir,
    branch: input.branch,
    baseBranch: input.baseBranch,
    title: input.prTitle,
    body: input.prBody,
    draft: false,
  });
  log.info('Opened PR', { pr: pr.url, workflowId: info.workflowId });

  let iter = 0;
  while (iter < maxIters) {
    // 2. CI loop.
    const ci = await ciWait.waitForCIActivity({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      pollIntervalSeconds: 30,
      maxWaitSeconds: 60 * 60,
    });

    if (ci.status === 'timeout') {
      throw ApplicationFailure.create({
        message: `CI did not converge within timeout for PR #${pr.number}`,
        type: 'CITimeout',
      });
    }

    if (ci.status === 'failure') {
      iter += 1;
      log.warn('CI failed; entering self-heal cycle', { iter, failedRunIds: ci.failedRunIds });
      const logsParts: string[] = [];
      for (const runId of ci.failedRunIds.slice(0, 3)) {
        const part = await cheap.fetchFailedRunLogsActivity({
          repoFullName: input.repoFullName,
          runId,
        });
        logsParts.push(`### Run ${runId}\n${part}`);
      }
      const failedLogs = logsParts.join('\n\n');

      const errorContext = await heavy.codexAnalyzeActivity({
        workdir: input.workdir,
        prompt:
          'CI failed with the logs below. Identify the failing test/build and the most ' +
          'relevant source files & line ranges to inspect. Produce a focused fix plan.\n\n' +
          'CI logs:\n' +
          failedLogs.slice(0, 64 * 1024),
      });

      await heavy.runClaudeActivity({
        workdir: input.workdir,
        systemPrompt:
          'You are an autonomous fix-it engineer. Apply MINIMAL changes to make CI pass. ' +
          'Do not add unrelated improvements.',
        context: errorContext.summary,
        prompt: 'Apply the fix plan above to the working tree, then stop.',
      });

      const commit = await heavy.commitAllActivity({
        workdir: input.workdir,
        message: `fix(ci): self-heal attempt ${iter}`,
      });
      if (!commit.committed) {
        throw ApplicationFailure.create({
          message: 'Claude reported success but produced no diff; cannot self-heal',
          type: 'NoFixDiff',
        });
      }
      await heavy.pushBranchActivity({
        workdir: input.workdir,
        branch: input.branch,
      });
      continue; // back to top of loop -> wait for CI again
    }

    // 3. Conflict loop (only after CI green).
    const conflict = await cheap.checkConflictActivity({
      workdir: input.workdir,
      baseBranch: input.baseBranch,
    });

    if (conflict.hasConflict) {
      iter += 1;
      log.warn('Merge conflict detected; entering resolve cycle', {
        iter,
        files: conflict.conflictedFiles,
      });
      const digest = await heavy.codexConflictDigestActivity({
        workdir: input.workdir,
        conflictedFiles: conflict.conflictedFiles,
        diffSummary: conflict.diffSummary ?? '',
      });
      await heavy.runClaudeActivity({
        workdir: input.workdir,
        systemPrompt:
          'You resolve git merge conflicts. Preserve intent from both sides whenever possible. ' +
          'Leave NO conflict markers in the resulting files.',
        context: digest.summary,
        prompt:
          'Resolve all merge conflicts in the working tree using the plan above. ' +
          `Conflicted files: ${conflict.conflictedFiles.join(', ')}.`,
      });
      const commit = await heavy.commitAllActivity({
        workdir: input.workdir,
        message: `chore(merge): resolve conflicts attempt ${iter}`,
      });
      if (!commit.committed) {
        throw ApplicationFailure.create({
          message: 'Conflict resolution produced no diff',
          type: 'NoFixDiff',
        });
      }
      await heavy.pushBranchActivity({
        workdir: input.workdir,
        branch: input.branch,
      });
      continue; // re-run CI after conflict resolution
    }

    // 4. All clear — merge.
    await cheap.mergePRActivity({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      mergeMethod: 'squash',
      deleteBranch: true,
    });
    return { prNumber: pr.number, prUrl: pr.url, iterations: iter };
  }

  throw ApplicationFailure.create({
    message: `PR #${pr.number} exceeded max self-heal iterations (${maxIters})`,
    type: 'MaxIterationsExceeded',
  });
}
