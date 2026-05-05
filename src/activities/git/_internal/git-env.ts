/**
 * Authentication / ref helpers shared across the `git/` activity cluster.
 * Internal-only — not re-exported from the activities barrel.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplicationFailure } from '@temporalio/activity';
import { execOrThrow } from '../../_internal/exec';
import { ERR_MISSING_CREDENTIALS, ERR_INVALID_GIT_REF } from '../../../errors';

/**
 * Build env that authenticates git over HTTPS to github.com WITHOUT putting
 * the token in argv or in the persistent on-disk git config. The auth header
 * lives only in process env, which is not logged in stderr or in our
 * `CommandFailed` error messages (which only echo argv).
 */
export function ghAuthEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN env var is missing on the worker',
      ERR_MISSING_CREDENTIALS,
    );
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

export function gitCloneUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

export interface PreparedGitWorkspace {
  workdir: string;
  env: NodeJS.ProcessEnv;
}

function gitBotIdentity(): { name: string; email: string } {
  // Identity stamped on every auto-generated commit. Required (no default):
  // a placeholder default would attribute commits to an account nobody on
  // the team owns, which is confusing in `git log` and on the GitHub PR
  // page. The operator must explicitly choose a known identity (e.g. their
  // own GitHub no-reply address) before the worker can run.
  const name = process.env.GIT_BOT_NAME;
  const email = process.env.GIT_BOT_EMAIL;
  if (!name || !email) {
    throw ApplicationFailure.nonRetryable(
      'GIT_BOT_NAME and GIT_BOT_EMAIL env vars are required on the worker so auto-generated commits attribute to a known account',
      ERR_MISSING_CREDENTIALS,
    );
  }
  return { name, email };
}

export async function prepareGitWorkspace(options: {
  repoFullName: string;
  workspaceRoot?: string;
}): Promise<PreparedGitWorkspace> {
  const root = options.workspaceRoot ?? process.env.WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'repo-steward-workspaces');
  await fs.mkdir(root, { recursive: true });
  const safeName = options.repoFullName.replace('/', '__');
  const workdir = await fs.mkdtemp(path.join(root, `${safeName}-`));

  const env = ghAuthEnv();
  const botIdentity = gitBotIdentity();
  await execOrThrow('git', ['clone', '--depth', '50', gitCloneUrl(options.repoFullName), workdir], {
    env,
  });
  await execOrThrow('git', ['config', 'user.email', botIdentity.email], { cwd: workdir });
  await execOrThrow('git', ['config', 'user.name', botIdentity.name], { cwd: workdir });

  return { workdir, env };
}

export function remoteBranchRef(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw ApplicationFailure.nonRetryable('base branch must not be empty', ERR_INVALID_GIT_REF);
  }
  return `refs/remotes/origin/${trimmed}`;
}

export function fetchRemoteBranchRefSpec(branch: string): string {
  const trimmed = branch.trim();
  return `${trimmed}:${remoteBranchRef(trimmed)}`;
}
