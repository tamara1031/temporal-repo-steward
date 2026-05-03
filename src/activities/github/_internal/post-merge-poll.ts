import type { PRLifecycleState } from '../observe-pr-state';

export type PostMergeOutcome = 'merged' | 'merge-queued' | 'closed-externally';

const DEFAULT_POST_MERGE_POLL_ATTEMPTS = 6;
const DEFAULT_POST_MERGE_POLL_INTERVAL_MS = 10_000;
const MAX_POST_MERGE_ACTIVITY_WAIT_MS = 4 * 60 * 1000;

export interface PostMergePollOptions {
  prNumber: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  maxActivityWaitMs?: number;
}

export interface PostMergePollDeps {
  observe: () => Promise<{ state: PRLifecycleState; mergedAt?: string }>;
  heartbeat: (details: unknown) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onTerminalOutcome?: (
    outcome: Exclude<PostMergeOutcome, 'merge-queued'>,
    observed: { state: PRLifecycleState; mergedAt?: string },
  ) => void;
}

export async function pollPostMergeOutcome(
  input: PostMergePollOptions,
  deps: PostMergePollDeps,
): Promise<PostMergeOutcome> {
  const attempts = Math.max(
    1,
    Math.floor(input.maxPollAttempts ?? DEFAULT_POST_MERGE_POLL_ATTEMPTS),
  );
  const intervalMs = Math.max(
    0,
    Math.floor(input.pollIntervalMs ?? DEFAULT_POST_MERGE_POLL_INTERVAL_MS),
  );
  const configuredWaitMs = attempts * intervalMs;
  const maxActivityWaitMs = Math.max(
    0,
    Math.floor(input.maxActivityWaitMs ?? MAX_POST_MERGE_ACTIVITY_WAIT_MS),
  );
  const deadlineMs = deps.now() + Math.min(configuredWaitMs, maxActivityWaitMs);

  deps.heartbeat({ phase: 'post-merge', prNumber: input.prNumber, attempt: 0 });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    deps.heartbeat({ phase: 'post-merge', prNumber: input.prNumber, attempt });
    const observed = await deps.observe();
    const outcome = mapPostMergeStateToOutcome(observed.state, false);
    if (outcome && outcome !== 'merge-queued') {
      deps.onTerminalOutcome?.(outcome, observed);
      return outcome;
    }

    const remainingMs = deadlineMs - deps.now();
    if (attempt >= attempts || remainingMs <= 0) break;
    await deps.sleep(Math.min(intervalMs, remainingMs));
  }

  return 'merge-queued';
}

export function mapPostMergeStateToOutcome(
  state: PRLifecycleState,
  waitBudgetExhausted: boolean,
): PostMergeOutcome | undefined {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed-externally';
  return waitBudgetExhausted ? 'merge-queued' : undefined;
}
