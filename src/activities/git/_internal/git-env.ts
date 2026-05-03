/**
 * Authentication / ref helpers shared across the `git/` activity cluster.
 * Internal-only — not re-exported from the activities barrel.
 */

import { ApplicationFailure } from '@temporalio/activity';
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
