import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplicationFailure } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { ERR_MISSING_CREDENTIALS } from '../../errors';
import { fetchRemoteBranchRefSpec, ghAuthEnv, gitCloneUrl } from './_internal/git-env';

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

  const root = input.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'repo-steward-workspaces');
  await fs.mkdir(root, { recursive: true });
  const safeName = input.repoFullName.replace('/', '__');
  const workdir = await fs.mkdtemp(path.join(root, `${safeName}-`));

  const env = ghAuthEnv();
  await execOrThrow('git', ['clone', '--depth', '50', gitCloneUrl(input.repoFullName), workdir], {
    env,
  });

  const botName = process.env.GIT_BOT_NAME;
  const botEmail = process.env.GIT_BOT_EMAIL;
  if (!botName || !botEmail) {
    throw ApplicationFailure.nonRetryable(
      'GIT_BOT_NAME and GIT_BOT_EMAIL env vars are required on the worker so auto-generated commits attribute to a known account',
      ERR_MISSING_CREDENTIALS,
    );
  }
  await execOrThrow('git', ['config', 'user.email', botEmail], { cwd: workdir });
  await execOrThrow('git', ['config', 'user.name', botName], { cwd: workdir });

  // The branch is already pushed to GitHub; fetch the remote tracking ref and
  // checkout a local tracking branch (git DWIM creates the tracking branch
  // automatically when there is a matching origin/<branch>).
  await execOrThrow(
    'git',
    ['fetch', '--depth', '50', 'origin', fetchRemoteBranchRefSpec(input.branch)],
    { cwd: workdir, env },
  );
  await execOrThrow('git', ['checkout', input.branch], { cwd: workdir });

  return { workdir };
}
