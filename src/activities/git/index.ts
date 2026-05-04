/**
 * git/ cluster — workspace + git-plumbing activities. Each activity is a
 * single file. Helpers are in `_internal/`.
 */

export { cloneRepoActivity } from './clone';
export type { CloneInput, CloneOutput } from './clone';

export { ensureWorkdirActivity } from './ensure-workdir';
export type { EnsureWorkdirInput, EnsureWorkdirOutput } from './ensure-workdir';

export { commitAllActivity } from './commit';
export type { CommitInput, CommitOutput } from './commit';

export { pushBranchActivity } from './push';
export type { PushInput } from './push';

export { checkConflictActivity } from './check-conflict';
export type { CheckConflictInput, CheckConflictOutput } from './check-conflict';

export { cleanupWorkspaceActivity } from './cleanup';
export type { CleanupInput } from './cleanup';

export { diffStatActivity } from './diff-stat';
export type { DiffStatInput, DiffStatOutput } from './diff-stat';

export { diffTextActivity } from './diff-text';
export type { DiffTextInput, DiffTextOutput } from './diff-text';

export { statusPorcelainActivity } from './status-porcelain';
export type { PorcelainInput, PorcelainOutput } from './status-porcelain';

export { restoreActivity } from './restore';
export type { RestoreInput } from './restore';

export { snapshotWorkdirActivity, popWorkdirSnapshotActivity } from './snapshot';
export type { SnapshotInput, SnapshotOutput } from './snapshot';

// Internal helpers re-exported for activities that need them across the
// cluster — but NOT re-exported from the activities barrel.
export {
  fetchRemoteBranchRefSpec,
  ghAuthEnv,
  gitCloneUrl,
  remoteBranchRef,
} from './_internal/git-env';
