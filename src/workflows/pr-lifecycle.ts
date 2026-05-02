import { log, workflowInfo, ApplicationFailure } from '@temporalio/workflow';
import { cheap, heavy, ciWait } from './proxies';
import { assertValidGitBranchName, assertValidRepoFullName } from '../validation';

export interface RobustPRMergeInput {
  repoFullName: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  prTitle: string;
  prBody: string;
  /** Hard cap on CI-fail / conflict iterations to prevent infinite loops. */
  maxFixIterations?: number;
  /** When false, run CI / self-heal but stop before merging. Defaults to true. */
  autoMerge?: boolean;
}

export interface RobustPRMergeOutput {
  prNumber: number;
  prUrl: string;
  iterations: number;
  merged: boolean;
}

/**
 * Common PR lifecycle:
 *   1. createPRActivity
 *   2. CI monitor loop — on failure: pull failed logs, codex fix, push, retry.
 *   3. Conflict resolution loop — on conflict: codex resolve, push, return to CI loop.
 *   4. mergePRActivity.
 */
export async function robustPRMergeWorkflow(
  input: RobustPRMergeInput,
): Promise<RobustPRMergeOutput> {
  assertValidRepoFullName(input.repoFullName);
  assertValidGitBranchName(input.branch);
  assertValidGitBranchName(input.baseBranch, 'baseBranch');

  const maxIters = input.maxFixIterations ?? 8;
  const autoMerge = input.autoMerge ?? true;
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

      const fix = await heavy.codexActivity({
        workdir: input.workdir,
        systemPrompt:
          'You are an autonomous fix-it engineer. Identify the failing test/build from ' +
          'the CI logs and apply MINIMAL changes to make CI pass. ' +
          'Do not add unrelated improvements.',
        context: 'CI logs:\n' + failedLogs.slice(0, 64 * 1024),
        prompt: 'Apply the minimal fix to the working tree, then stop.',
      });

      const commit = await heavy.commitAllActivity({
        workdir: input.workdir,
        message: `fix(ci): self-heal attempt ${iter}`,
      });
      if (!commit.committed) {
        throw ApplicationFailure.create({
          message: 'Codex reported success but produced no diff; cannot self-heal',
          type: 'NoFixDiff',
          details: [fix.message.slice(0, 4096)],
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
      const resolve = await heavy.codexActivity({
        workdir: input.workdir,
        systemPrompt:
          'You resolve git merge conflicts. Preserve intent from both sides whenever possible. ' +
          'Leave NO conflict markers in the resulting files.',
        context: 'Conflict diff:\n' + (conflict.diffSummary ?? ''),
        paths: conflict.conflictedFiles,
        prompt:
          'Resolve all merge conflicts in the working tree. ' +
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
          details: [resolve.message.slice(0, 4096)],
        });
      }
      await heavy.pushBranchActivity({
        workdir: input.workdir,
        branch: input.branch,
      });
      continue; // re-run CI after conflict resolution
    }

    // 4. All clear — merge (unless autoMerge is disabled).
    if (!autoMerge) {
      log.info('autoMerge=false; skipping merge', { pr: pr.url, workflowId: info.workflowId });
      return { prNumber: pr.number, prUrl: pr.url, iterations: iter, merged: false };
    }
    await cheap.mergePRActivity({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      mergeMethod: 'squash',
      deleteBranch: true,
    });
    return { prNumber: pr.number, prUrl: pr.url, iterations: iter, merged: true };
  }

  throw ApplicationFailure.create({
    message: `PR #${pr.number} exceeded max self-heal iterations (${maxIters})`,
    type: 'MaxIterationsExceeded',
  });
}
