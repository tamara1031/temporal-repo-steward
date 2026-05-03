import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplicationFailure } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { ERR_MISSING_CREDENTIALS } from '../../errors';
import {
  fetchRemoteBranchRefSpec,
  ghAuthEnv,
  gitCloneUrl,
  remoteBranchRef,
} from './_internal/git-env';

export interface CloneInput {
  repoFullName: string;
  ref?: string;
  branch: string;
  workspaceRoot?: string;
}

export interface CloneOutput {
  workdir: string;
  branch: string;
  baseSha: string;
}

export async function cloneRepoActivity(input: CloneInput): Promise<CloneOutput> {
  const root = input.workspaceRoot ?? path.join(os.tmpdir(), 'repo-steward-workspaces');
  await fs.mkdir(root, { recursive: true });
  const safeName = input.repoFullName.replace('/', '__');
  const workdir = await fs.mkdtemp(path.join(root, `${safeName}-`));

  const env = ghAuthEnv();
  await execOrThrow('git', ['clone', '--depth', '50', gitCloneUrl(input.repoFullName), workdir], {
    env,
  });

  // Identity stamped on every auto-generated commit. Required (no default):
  // a placeholder default would attribute commits to an account nobody on
  // the team owns, which is confusing in `git log` and on the GitHub PR
  // page. The operator must explicitly choose a known identity (e.g. their
  // own GitHub no-reply address) before the worker can run.
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

  if (input.ref) {
    const remoteRef = remoteBranchRef(input.ref);
    await execOrThrow(
      'git',
      ['fetch', '--depth', '50', 'origin', fetchRemoteBranchRefSpec(input.ref)],
      { cwd: workdir, env },
    );
    await execOrThrow('git', ['checkout', '--detach', remoteRef], { cwd: workdir });
  }

  await execOrThrow('git', ['checkout', '-b', input.branch], { cwd: workdir });

  const headRes = await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workdir });
  return {
    workdir,
    branch: input.branch,
    baseSha: headRes.stdout.trim(),
  };
}
