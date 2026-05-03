import { Context, log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { ghEnv, sleepCancellable } from './_internal/gh-env';
import {
  parsePRStateJSON,
  type ObservePRStateOutput,
  type PRLifecycleState,
} from './observe-pr-state';

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
const HEARTBEAT_TICK_MS = 30 * 1000;

/**
 * Long-running PR lifecycle poll. This stays in an Activity so the wait can
 * heartbeat and be cancelled without workflow-side timers.
 */
export async function waitForPRStateActivity(
  input: WaitForPRStateInput,
): Promise<WaitForPRStateOutput> {
  const env = ghEnv();
  const ctx = Context.current();
  const interval = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const targetStates = new Set<PRLifecycleState>(input.targetStates ?? ['CLOSED', 'MERGED']);

  let lastObserved: ObservePRStateOutput | undefined;
  let heartbeatRunning = true;
  ctx.heartbeat({ phase: 'wait-pr-state', prNumber: input.prNumber });
  const heartbeatTask = (async () => {
    while (heartbeatRunning) {
      try {
        await sleepCancellable(HEARTBEAT_TICK_MS, ctx.cancellationSignal);
      } catch {
        return;
      }
      if (!heartbeatRunning) return;
      ctx.heartbeat({ phase: 'wait-pr-state', prNumber: input.prNumber });
    }
  })();
  heartbeatTask.catch(() => undefined);

  try {
    while (Date.now() < deadline) {
      lastObserved = await observePRState(input.repoFullName, input.prNumber, env);
      if (targetStates.has(lastObserved.state)) {
        log.info('Observed target PR state', {
          prNumber: input.prNumber,
          state: lastObserved.state,
        });
        return { ...lastObserved, timedOut: false };
      }
      await sleepCancellable(interval, ctx.cancellationSignal);
    }

    return {
      ...(lastObserved ?? { state: 'OPEN' as const }),
      timedOut: true,
    };
  } finally {
    heartbeatRunning = false;
    await heartbeatTask.catch(() => undefined);
  }
}

async function observePRState(
  repoFullName: string,
  prNumber: number,
  env: NodeJS.ProcessEnv,
): Promise<ObservePRStateOutput> {
  const res = await execOrThrow(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repoFullName,
      '--json',
      'state,mergedAt',
    ],
    { env },
  );
  return parsePRStateJSON(res.stdout);
}
