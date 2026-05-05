import * as fs from 'fs/promises';
import { execOrThrow } from '../_internal/exec';
import { fetchRemoteBranchRefSpec, prepareGitWorkspace } from './_internal/git-env';

export interface EnsureWorkdirInput {
  workdir: string;
  repoFullName: string;
  branch: string;
  workspaceRoot?: string;
}

export interface EnsureWorkdirOutput {
  workdir: string;
}

/**
 * Returns `workdir` unchanged if the directory still exists on this pod.
 * When the pod was replaced since the workspace was created the directory is
 * gone; this activity clones the repository fresh and checks out the
 * already-pushed branch, returning the new workspace path.
 *
 * Call this at the start of any workflow section that uses the workdir after a
 * long-running activity (e.g. waitForCIActivity) during which the pod may have
 * been recycled.
 */
export async function ensureWorkdirActivity(
  input: EnsureWorkdirInput,
): Promise<EnsureWorkdirOutput> {
  try {
    await fs.stat(input.workdir);
    return { workdir: input.workdir };
  } catch {
    // Directory is gone — fall through to re-clone.
  }

  const { workdir, env } = await prepareGitWorkspace({
    repoFullName: input.repoFullName,
    workspaceRoot: input.workspaceRoot,
  });

  // The branch is already pushed to GitHub; fetch the remote tracking ref and
  // checkout a local tracking branch (git DWIM creates the tracking branch
  // automatically when there is a matching origin/<branch>).
  await execOrThrow(
    'git',
    ['fetch', '--depth', '50', 'origin', fetchRemoteBranchRefSpec(input.branch)],
    { cwd: workdir, env },
  );
  await execOrThrow('git', ['checkout', '-b', input.branch, 'FETCH_HEAD'], { cwd: workdir });

  return { workdir };
}
