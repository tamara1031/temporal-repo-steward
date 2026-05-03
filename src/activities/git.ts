import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApplicationFailure, log } from '@temporalio/activity';
import { execCommand, execOrThrow } from './exec';

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

export function remoteBranchRef(branch: string): string {
  const trimmed = branch.trim();
  if (!trimmed) {
    throw ApplicationFailure.nonRetryable('base branch must not be empty', 'InvalidGitRef');
  }
  return `refs/remotes/origin/${trimmed}`;
}

export function fetchRemoteBranchRefSpec(branch: string): string {
  const trimmed = branch.trim();
  return `${trimmed}:${remoteBranchRef(trimmed)}`;
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

  // Identity used by all auto-generated commits. Override with GIT_BOT_NAME /
  // GIT_BOT_EMAIL on the Worker so the commits clearly attribute to a known
  // bot account (e.g. your own GitHub no-reply address) instead of the
  // default placeholder.
  const botName = process.env.GIT_BOT_NAME ?? 'repo-steward-bot';
  const botEmail = process.env.GIT_BOT_EMAIL ?? 'ai-agent@users.noreply.github.com';
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

// ──────────────────────────────────────────────────────────────────────────
// Refactor-pipeline git helpers (used by periodicRefactorWorkflow's
// pre-Parliament gate, drift audit, and rollback paths). Each is a separate
// Activity so the Temporal UI shows the gate decision and drift state.
// ──────────────────────────────────────────────────────────────────────────

export interface DiffStatInput {
  workdir: string;
}

export interface DiffStatOutput {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * Parse `git diff --shortstat` (e.g. " 2 files changed, 18 insertions(+), 7 deletions(-)").
 * Empty diff returns zeros. Used for the pre-Parliament trivial-diff gate.
 */
export async function diffStatActivity(input: DiffStatInput): Promise<DiffStatOutput> {
  const res = await execOrThrow('git', ['diff', '--shortstat'], { cwd: input.workdir });
  const text = res.stdout.trim();
  if (!text) return { filesChanged: 0, insertions: 0, deletions: 0 };
  const filesMatch = text.match(/(\d+)\s+files?\s+changed/);
  const insMatch = text.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = text.match(/(\d+)\s+deletions?\(-\)/);
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  };
}

export interface DiffTextInput {
  workdir: string;
  /** Truncate the returned diff to this many bytes. Default 8 KiB. */
  maxBytes?: number;
}

export interface DiffTextOutput {
  /** UTF-8 truncated diff text. Empty when there are no changes. */
  text: string;
  /** True when the underlying `git diff` was longer than `maxBytes`. */
  truncated: boolean;
}

/** Full unified diff for reviewer input. Truncated to keep activity payloads small. */
export async function diffTextActivity(input: DiffTextInput): Promise<DiffTextOutput> {
  const res = await execOrThrow('git', ['diff'], { cwd: input.workdir });
  const max = input.maxBytes ?? 8 * 1024;
  if (res.stdout.length <= max) return { text: res.stdout, truncated: false };
  return { text: res.stdout.slice(0, max), truncated: true };
}

export interface PorcelainInput {
  workdir: string;
}

export interface PorcelainOutput {
  /** `git status --porcelain` lines (e.g. ` M src/foo.ts`, `?? src/bar.ts`). */
  entries: string[];
}

/** Snapshot working-tree state. Used to detect reviewer drift between Parliament rounds. */
export async function statusPorcelainActivity(input: PorcelainInput): Promise<PorcelainOutput> {
  const res = await execOrThrow('git', ['status', '--porcelain'], { cwd: input.workdir });
  const entries = res.stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean);
  return { entries };
}

export interface RestoreInput {
  workdir: string;
  /** When omitted, restores everything (`git restore .`). */
  paths?: string[];
}

export async function restoreActivity(input: RestoreInput): Promise<void> {
  const args = ['checkout', '--'];
  if (input.paths && input.paths.length > 0) {
    args.push(...input.paths);
  } else {
    // `git restore .` is the documented form, but `git checkout -- .` is universally available.
    args.push('.');
  }
  await execOrThrow('git', args, { cwd: input.workdir });
}
