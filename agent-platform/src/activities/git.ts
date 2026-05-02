import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Context, ApplicationFailure } from '@temporalio/activity';
import { execOrThrow } from './_exec';

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

function ghAuthEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN env var is missing on the worker',
      'MissingCredentials',
    );
  }
  return {
    GIT_TERMINAL_PROMPT: '0',
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

function gitCloneUrl(repoFullName: string): string {
  const token = process.env.GITHUB_TOKEN;
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`;
}

export async function cloneRepoActivity(input: CloneInput): Promise<CloneOutput> {
  const root = input.workspaceRoot ?? path.join(os.tmpdir(), 'agent-platform-workspaces');
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
  await execOrThrow('git', ['config', 'user.name', 'agent-platform-bot'], { cwd: workdir });

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

export async function checkConflictActivity(
  input: CheckConflictInput,
): Promise<CheckConflictOutput> {
  const env = ghAuthEnv();
  await execOrThrow('git', ['fetch', 'origin', input.baseBranch], { cwd: input.workdir, env });
  // Try a no-commit merge to detect conflicts.
  const merge = await execOrThrow('git', ['merge', '--no-commit', '--no-ff', `origin/${input.baseBranch}`], {
    cwd: input.workdir,
    env,
  }).catch((err) => {
    Context.current().log.info('Merge attempt produced non-zero exit', { err: String(err) });
    return null;
  });

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

  // Always abort the trial merge — the workflow decides next steps.
  await execOrThrow('git', ['merge', '--abort'], { cwd: input.workdir }).catch(() => undefined);

  return {
    hasConflict: conflicted.length > 0,
    conflictedFiles: conflicted,
    diffSummary,
    // Keep merge result reachable for debugging.
    ...(merge ? {} : {}),
  };
}

export interface CleanupInput {
  workdir: string;
}

export async function cleanupWorkspaceActivity(input: CleanupInput): Promise<void> {
  await fs.rm(input.workdir, { recursive: true, force: true });
}
