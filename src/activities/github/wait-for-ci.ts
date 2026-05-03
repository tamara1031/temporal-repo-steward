import { Context, log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { decideCIStatus, parseStatusCheckRollupJSON, type CompletedCIDecision } from './_internal/ci-rollup';
import { ghEnv, sleepCancellable } from './_internal/gh-env';

export interface WaitForCIInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
}

export interface CIResult {
  status: 'success' | 'failure' | 'timeout';
  failedRunIds: string[];
  failedJobNames: string[];
}

/**
 * Background heartbeat cadence — independent of `pollIntervalSeconds` so that
 * a slow `gh pr view` call or a large `pollIntervalSeconds` can't cause the
 * proxy's `heartbeatTimeout` (2 min) to fire on a still-healthy activity.
 * Half the heartbeat timeout is a safe rule of thumb.
 */
const HEARTBEAT_TICK_MS = 30 * 1000;

export async function waitForCIActivity(input: WaitForCIInput): Promise<CIResult> {
  const env = ghEnv();
  const interval = (input.pollIntervalSeconds ?? 30) * 1000;
  const deadline = Date.now() + (input.maxWaitSeconds ?? 60 * 60) * 1000;
  const ctx = Context.current();

  // Independent heartbeat ticker. Fires every HEARTBEAT_TICK_MS regardless of
  // poll progress so cancellation can still be delivered (cancellation arrives
  // via heartbeat) and the proxy's heartbeatTimeout doesn't trip.
  let heartbeatRunning = true;
  ctx.heartbeat({ phase: 'wait-ci', prNumber: input.prNumber });
  const heartbeatTask = (async () => {
    while (heartbeatRunning) {
      try {
        await sleepCancellable(HEARTBEAT_TICK_MS, ctx.cancellationSignal);
      } catch {
        return; // cancellation — stop ticking
      }
      if (!heartbeatRunning) return;
      ctx.heartbeat({ phase: 'wait-ci', prNumber: input.prNumber });
    }
  })();
  // Swallow heartbeat-task errors; the main loop owns activity success/failure.
  heartbeatTask.catch(() => undefined);

  try {
    while (Date.now() < deadline) {
      const view = await execOrThrow(
        'gh',
        [
          'pr',
          'view',
          String(input.prNumber),
          '--repo',
          input.repoFullName,
          '--json',
          'statusCheckRollup',
        ],
        { env },
      );
      const checks = parseStatusCheckRollupJSON(view.stdout);
      const decision = decideCIStatus(checks);

      if (decision.status === 'success' && checks.length === 0) {
        log.info('No CI checks configured for PR — treating as success', { pr: input.prNumber });
        return toCIResult(decision);
      }

      if (decision.status !== 'pending') {
        return toCIResult(decision);
      }

      await sleepCancellable(interval, ctx.cancellationSignal);
    }
    return { status: 'timeout', failedRunIds: [], failedJobNames: [] };
  } finally {
    heartbeatRunning = false;
    await heartbeatTask.catch(() => undefined);
  }
}

function toCIResult(decision: CompletedCIDecision): CIResult {
  return {
    status: decision.status,
    failedRunIds: decision.failedRunIds,
    failedJobNames: decision.failedJobNames,
  };
}
