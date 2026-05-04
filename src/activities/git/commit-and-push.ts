import { execOrThrow } from '../_internal/exec';
import { fetchRemoteBranchRefSpec, ghAuthEnv } from './_internal/git-env';

export interface CommitAndPushInput {
  workdir: string;
  branch: string;
  message: string;
}

export interface CommitAndPushOutput {
  /**
   * True when a NEW commit was created this call (working tree was dirty).
   * False when the tree was already clean — either nothing changed, or the
   * commit already existed from a prior interrupted attempt.
   */
  committed: boolean;
  /**
   * True when a push reached origin.  Covers both new commits and commits
   * that existed locally from a prior attempt whose push was interrupted.
   *
   * Use `!pushed` as the NoFixDiff signal: if nothing was pushed, codex
   * produced no work and there is nothing left to persist.
   */
  pushed: boolean;
  /** HEAD sha after the operation. */
  sha: string;
}

/**
 * Atomic commit-and-push.  A single Temporal activity so that "commit
 * succeeded, pod replaced before push" is detected and healed on retry:
 *
 *   1. Fetch origin/<branch> to refresh the remote-tracking ref.
 *   2. Compare local HEAD with origin/<branch> — a divergence means a prior
 *      attempt committed but did not reach GitHub (pendingPush).
 *   3. Stage all working-tree changes.
 *   4. Commit if the tree is dirty.
 *   5. Push when (a) we just committed OR (b) pendingPush is true.
 *
 * This guarantees that after a successful return, GitHub holds at least the
 * same commit as the local HEAD, making the remote branch the sole source of
 * truth that ensureWorkdirActivity can re-clone from after a pod replacement.
 */
export async function commitAndPushActivity(
  input: CommitAndPushInput,
): Promise<CommitAndPushOutput> {
  const env = ghAuthEnv();

  // Refresh the remote-tracking ref.  If this fails (e.g. the branch has not
  // been pushed yet) that is a caller error, so we let execOrThrow propagate.
  await execOrThrow('git', ['fetch', 'origin', fetchRemoteBranchRefSpec(input.branch)], { cwd: input.workdir, env });

  const localSha = (
    await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: input.workdir })
  ).stdout.trim();
  const originSha = (
    await execOrThrow('git', ['rev-parse', `origin/${input.branch}`], { cwd: input.workdir })
  ).stdout.trim();

  // A prior attempt committed but the push was interrupted.
  const hasPendingPush = localSha !== originSha;

  await execOrThrow('git', ['add', '-A'], { cwd: input.workdir });
  const status = await execOrThrow('git', ['status', '--porcelain'], { cwd: input.workdir });
  const dirty = !!status.stdout.trim();

  let committed = false;
  if (dirty) {
    await execOrThrow('git', ['commit', '-m', input.message], { cwd: input.workdir });
    committed = true;
  }

  const shouldPush = committed || hasPendingPush;
  if (shouldPush) {
    await execOrThrow('git', ['push', 'origin', input.branch], { cwd: input.workdir, env });
  }

  const sha = (
    await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: input.workdir })
  ).stdout.trim();

  return { committed, pushed: shouldPush, sha };
}
