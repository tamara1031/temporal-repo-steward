import type { ObservePRStateOutput, PRLifecycleState } from '../observe-pr-state';
import {
  GITHUB_PR_STATE_POLL_DEFAULTS,
  normalizePollTimingWithDefaults,
  pollWithBudget,
} from './polling-budget';

export interface WaitForPRStatePollOptions {
  prNumber: number;
  targetStates?: PRLifecycleState[];
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface WaitForPRStateOutput extends ObservePRStateOutput {
  timedOut: boolean;
}

export interface WaitForPRStatePollDeps {
  observe: () => Promise<ObservePRStateOutput>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onTargetState?: (observed: ObservePRStateOutput) => void;
}

export async function pollPRState(
  input: WaitForPRStatePollOptions,
  deps: WaitForPRStatePollDeps,
): Promise<WaitForPRStateOutput> {
  const timing = normalizePollTimingWithDefaults({
    nowMs: deps.now(),
    intervalMs: input.pollIntervalMs,
    maxWaitMs: input.maxWaitMs,
    defaults: GITHUB_PR_STATE_POLL_DEFAULTS,
  });
  const targetStates = new Set<PRLifecycleState>(input.targetStates ?? ['CLOSED', 'MERGED']);
  let lastObserved: ObservePRStateOutput | undefined;

  return pollWithBudget<WaitForPRStateOutput>({
    intervalMs: timing.intervalMs,
    defaultIntervalMs: GITHUB_PR_STATE_POLL_DEFAULTS.intervalMs,
    deadlineMs: timing.deadlineMs,
    now: deps.now,
    sleep: deps.sleep,
    observe: async () => {
      lastObserved = await deps.observe();
      if (targetStates.has(lastObserved.state)) {
        deps.onTargetState?.(lastObserved);
        return { done: true, value: { ...lastObserved, timedOut: false } };
      }
      return { done: false };
    },
    onTimeout: () => ({
      ...(lastObserved ?? { state: 'OPEN' as const }),
      timedOut: true,
    }),
  });
}

export const DEFAULT_PR_STATE_MAX_WAIT_MS = GITHUB_PR_STATE_POLL_DEFAULTS.maxWaitMs;
export const DEFAULT_PR_STATE_POLL_INTERVAL_MS = GITHUB_PR_STATE_POLL_DEFAULTS.intervalMs;
