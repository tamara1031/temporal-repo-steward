import type { ObservePRStateOutput, PRLifecycleState } from '../observe-pr-state';
import { nextPollSleepMs, normalizePollIntervalMs } from './polling-budget';

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

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;

export async function pollPRState(
  input: WaitForPRStatePollOptions,
  deps: WaitForPRStatePollDeps,
): Promise<WaitForPRStateOutput> {
  const interval = normalizePollIntervalMs(
    input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = deps.now() + (input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const targetStates = new Set<PRLifecycleState>(input.targetStates ?? ['CLOSED', 'MERGED']);
  let lastObserved: ObservePRStateOutput | undefined;

  while (deps.now() < deadline) {
    lastObserved = await deps.observe();
    if (targetStates.has(lastObserved.state)) {
      deps.onTargetState?.(lastObserved);
      return { ...lastObserved, timedOut: false };
    }
    const sleepMs = nextPollSleepMs(deadline, deps.now(), interval);
    if (sleepMs === undefined) {
      break;
    }
    await deps.sleep(sleepMs);
  }

  return {
    ...(lastObserved ?? { state: 'OPEN' as const }),
    timedOut: true,
  };
}

export { DEFAULT_MAX_WAIT_MS as DEFAULT_PR_STATE_MAX_WAIT_MS };
export { DEFAULT_POLL_INTERVAL_MS as DEFAULT_PR_STATE_POLL_INTERVAL_MS };
