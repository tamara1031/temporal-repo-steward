import type { PRLifecycleState } from '../observe-pr-state';
import {
  GITHUB_POST_MERGE_POLL_DEFAULTS,
  normalizeAttemptPollTimingWithDefaults,
  pollWithBudget,
} from './polling-budget';

export type PostMergeOutcome = 'merged' | 'merge-queued' | 'closed-externally';

export interface PostMergePollOptions {
  prNumber: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  maxActivityWaitMs?: number;
}

export interface PostMergePollDeps {
  observe: () => Promise<{ state: PRLifecycleState; mergedAt?: string }>;
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
  const timing = normalizeAttemptPollTimingWithDefaults({
    nowMs: deps.now(),
    intervalMs:
      input.pollIntervalMs === undefined ? undefined : Math.floor(input.pollIntervalMs),
    attempts: input.maxPollAttempts,
    maxWaitMs: input.maxActivityWaitMs,
    defaults: GITHUB_POST_MERGE_POLL_DEFAULTS,
  });

  return pollWithBudget<PostMergeOutcome>({
    intervalMs: timing.intervalMs,
    defaultIntervalMs: GITHUB_POST_MERGE_POLL_DEFAULTS.intervalMs,
    deadlineMs: timing.deadlineMs,
    now: deps.now,
    sleep: deps.sleep,
    maxAttempts: timing.attempts,
    observeAtDeadline: true,
    observe: async () => {
      const observed = await deps.observe();
      const outcome = mapPostMergeStateToOutcome(observed.state, false);
      if (outcome && outcome !== 'merge-queued') {
        deps.onTerminalOutcome?.(outcome, observed);
        return { done: true, value: outcome };
      }
      return { done: false };
    },
    onTimeout: () => 'merge-queued',
  });
}

export function mapPostMergeStateToOutcome(
  state: PRLifecycleState,
  waitBudgetExhausted: boolean,
): PostMergeOutcome | undefined {
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed-externally';
  return waitBudgetExhausted ? 'merge-queued' : undefined;
}
