import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApplicationFailure, log } from '@temporalio/activity';
import { execCommand, execOrThrow } from './exec';
import {
  assertValidGitBranchName,
  assertValidRepoFullName,
  InvalidInputError,
} from '../validation';

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

/**
 * Build env that authenticates git over HTTPS to github.com WITHOUT putting
 * the token in argv or in the persistent on-disk git config. The auth header
 * lives only in process env, which is not logged in stderr or in our
 * `CommandFailed` error messages (which only echo argv).
 */
function ghAuthEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN env var is missing on the worker',
      'MissingCredentials',
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

function gitCloneUrl(repoFullName: string): string {
  return `https://github.com/${repoFullName}.git`;
}

function validateInput(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof InvalidInputError) {
      throw ApplicationFailure.nonRetryable(err.message, 'InvalidInput');
    }
    throw err;
  }
}

export async function cloneRepoActivity(input: CloneInput): Promise<CloneOutput> {
  validateInput(() => {
    assertValidRepoFullName(input.repoFullName);
    assertValidGitBranchName(input.branch);
    if (input.ref) assertValidGitBranchName(input.ref, 'ref');
  });

  const root = input.workspaceRoot ?? path.join(os.tmpdir(), 'repo-steward-workspaces');
  await fs.mkdir(root, { recursive: true });
  const safeName = input.repoFullName.replace('/', '__');
  const workdir = await fs.mkdtemp(path.join(root, `${safeName}-`));

  const env = ghAuthEnv();
  await execOrThrow('git', ['clone', '--depth', '50', gitCloneUrl(input.repoFullName), workdir], {
    env,
  });

  await execOrThrow('git', ['config', 'user.email', 'ai-agent@users.noreply.github.com'], {
    cwd: workdir,
  });
  await execOrThrow('git', ['config', 'user.name', 'repo-steward-bot'], { cwd: workdir });

  if (input.ref) {
    await execOrThrow('git', ['fetch', 'origin', input.ref], { cwd: workdir, env });
    await execOrThrow('git', ['checkout', input.ref], { cwd: workdir });
  }

  await execOrThrow('git', ['checkout', '-b', input.branch], { cwd: workdir });

  const headRes = await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workdir });
  return {
    workdir,
    branch: input.branch,
    baseSha: headRes.stdout.trim(),
  };
}

export interface CommitInput {
  workdir: string;
  message: string;
}

export interface CommitOutput {
  committed: boolean;
  sha?: string;
}

export async function commitAllActivity(input: CommitInput): Promise<CommitOutput> {
  await execOrThrow('git', ['add', '-A'], { cwd: input.workdir });
  const status = await execOrThrow('git', ['status', '--porcelain'], { cwd: input.workdir });
  if (!status.stdout.trim()) {
    return { committed: false };
  }
  await execOrThrow('git', ['commit', '-m', input.message], { cwd: input.workdir });
  const sha = (await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: input.workdir })).stdout
    .trim();
  return { committed: true, sha };
}

export interface PushInput {
  workdir: string;
  branch: string;
  setUpstream?: boolean;
  force?: boolean;
}

export async function pushBranchActivity(input: PushInput): Promise<void> {
  validateInput(() => assertValidGitBranchName(input.branch));

  const env = ghAuthEnv();
  const args = ['push'];
  if (input.setUpstream) args.push('-u');
  if (input.force) args.push('--force-with-lease');
  args.push('origin', input.branch);
  await execOrThrow('git', args, { cwd: input.workdir, env });
}

export interface CheckConflictInput {
  workdir: string;
  baseBranch: string;
}

export interface CheckConflictOutput {
  hasConflict: boolean;
  conflictedFiles: string[];
  diffSummary?: string;
}

async function isMergeInProgress(workdir: string): Promise<boolean> {
  try {
    await fs.access(path.join(workdir, '.git', 'MERGE_HEAD'));
    return true;
  } catch {
    return false;
  }
}

export async function checkConflictActivity(
  input: CheckConflictInput,
): Promise<CheckConflictOutput> {
  validateInput(() => assertValidGitBranchName(input.baseBranch, 'baseBranch'));

  const env = ghAuthEnv();
  await execOrThrow('git', ['fetch', 'origin', input.baseBranch], { cwd: input.workdir, env });

  // Trial merge with --no-commit --no-ff. A non-zero exit only signals "conflicts
  // present"; we still need to scan the index to enumerate them.
  const trial = await execCommand(
    'git',
    ['merge', '--no-commit', '--no-ff', `origin/${input.baseBranch}`],
    { cwd: input.workdir, env },
  );
  if (trial.code !== 0) {
    log.info('Trial merge exited non-zero (likely conflicts)', { code: trial.code });
  }

  const diff = await execOrThrow('git', ['diff', '--name-only', '--diff-filter=U'], {
    cwd: input.workdir,
  });
  const conflicted = diff.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  let diffSummary: string | undefined;
  if (conflicted.length > 0) {
    const summary = await execOrThrow('git', ['diff', '--cc'], { cwd: input.workdir });
    diffSummary = summary.stdout.slice(0, 16 * 1024);
  }

  // Abort only when a merge is actually in progress; otherwise `merge --abort`
  // would error spuriously.
  if (await isMergeInProgress(input.workdir)) {
    await execCommand('git', ['merge', '--abort'], { cwd: input.workdir });
  }

  return {
    hasConflict: conflicted.length > 0,
    conflictedFiles: conflicted,
    diffSummary,
  };
}

export interface CleanupInput {
  workdir: string;
}

export async function cleanupWorkspaceActivity(input: CleanupInput): Promise<void> {
  await fs.rm(input.workdir, { recursive: true, force: true });
}
