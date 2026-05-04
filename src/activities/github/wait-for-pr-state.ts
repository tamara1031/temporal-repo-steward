import { log } from '@temporalio/activity';
import { ghEnv } from './_internal/gh-env';
import { observePRState } from './_internal/pr-state';
import { withGitHubWaitHeartbeat } from './_internal/wait-heartbeat';
import { type ObservePRStateOutput, type PRLifecycleState } from './observe-pr-state';

export interface WaitForPRStateInput {
  repoFullName: string;
  prNumber: number;
  /**
   * States that should end the wait. Defaults to CLOSED or MERGED, which is
   * the usual "wait until the PR is no longer open" lifecycle gate.
   */
  targetStates?: PRLifecycleState[];
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface WaitForPRStateOutput extends ObservePRStateOutput {
  timedOut: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 30 * 1000;
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * Long-running PR lifecycle poll. This stays in an Activity so the wait can
 * heartbeat and be cancelled without workflow-side timers.
 */
export async function waitForPRStateActivity(
  input: WaitForPRStateInput,
): Promise<WaitForPRStateOutput> {
  const env = ghEnv();
  const interval = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const targetStates = new Set<PRLifecycleState>(input.targetStates ?? ['CLOSED', 'MERGED']);

  let lastObserved: ObservePRStateOutput | undefined;

  return withGitHubWaitHeartbeat(
    { phase: 'wait-pr-state', prNumber: input.prNumber },
    async ({ sleep }) => {
      while (Date.now() < deadline) {
        lastObserved = await observePRState(input.repoFullName, input.prNumber, env);
        if (targetStates.has(lastObserved.state)) {
          log.info('Observed target PR state', {
            prNumber: input.prNumber,
            state: lastObserved.state,
          });
          return { ...lastObserved, timedOut: false };
        }
        await sleep(interval);
      }

      return {
        ...(lastObserved ?? { state: 'OPEN' as const }),
        timedOut: true,
      };
    },
  );
}
