import { Context, log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { decideCIStatus, parseStatusCheckRollupJSON, type CompletedCIDecision } from './_internal/ci-rollup';
import { ghEnv, sleepCancellable } from './_internal/gh-env';
import { invalidGhOutput, isRecord, parseGhJSON } from './_internal/gh-json';

export interface WaitForCIInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
}

/**
 * Terminal statuses observed by `waitForCIActivity`:
 *  - `success` / `failure`: CI checks have settled with that outcome.
 *  - `timeout`: hit `maxWaitSeconds` without a settled rollup.
 *  - `closed`: the PR was closed externally (human cancellation, base
 *    deleted, etc.). The workflow must exit cleanly — no self-heal applies.
 *  - `merged`: the PR was merged externally (e.g. base force-pushed, manual
 *    merge by a reviewer). Treat as a successful early exit.
 */
export interface CIResult {
  status: 'success' | 'failure' | 'timeout' | 'closed' | 'merged';
  failedRunIds: string[];
  failedJobNames: string[];
}

type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

interface PRWithChecks {
  state: PRState;
  checksJson: string;
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
          'statusCheckRollup,state',
        ],
        { env },
      );
      const observed = parsePRWithChecks(view.stdout);
      // External lifecycle wins over CI status: if a human / GitHub closed or
      // merged the PR we must not push more commits or attempt to self-heal
      // against a phantom branch.
      if (observed.state === 'CLOSED') {
        log.info('PR closed externally; exiting CI wait', { pr: input.prNumber });
        return { status: 'closed', failedRunIds: [], failedJobNames: [] };
      }
      if (observed.state === 'MERGED') {
        log.info('PR merged externally; exiting CI wait', { pr: input.prNumber });
        return { status: 'merged', failedRunIds: [], failedJobNames: [] };
      }

      const checks = parseStatusCheckRollupJSON(observed.checksJson);
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

/**
 * Parse `gh pr view --json statusCheckRollup,state`. We carry the rollup as
 * raw JSON forward into `parseStatusCheckRollupJSON` rather than decoding it
 * twice — keeps the existing helper as the single source of rollup truth.
 */
function parsePRWithChecks(stdout: string): PRWithChecks {
  const data = parseGhJSON(stdout, 'gh pr view --json statusCheckRollup,state');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json statusCheckRollup,state output must be a JSON object');
  }
  const stateRaw = data.state;
  if (stateRaw !== 'OPEN' && stateRaw !== 'CLOSED' && stateRaw !== 'MERGED') {
    throw invalidGhOutput(
      `gh pr view returned unexpected state ${JSON.stringify(stateRaw)}; expected OPEN|CLOSED|MERGED`,
    );
  }
  return {
    state: stateRaw,
    checksJson: JSON.stringify({ statusCheckRollup: data.statusCheckRollup ?? [] }),
  };
}

function toCIResult(decision: CompletedCIDecision): CIResult {
  return {
    status: decision.status,
    failedRunIds: decision.failedRunIds,
    failedJobNames: decision.failedJobNames,
  };
}
