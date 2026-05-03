import { Context, log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import {
  decideCIStatus,
  evaluateStabilization,
  parseStatusCheckRollupJSON,
  type CompletedCIDecision,
  type RollupSnapshot,
} from './_internal/ci-rollup';
import { ghEnv, sleepCancellable } from './_internal/gh-env';
import { invalidGhOutput, isRecord, parseGhJSON } from './_internal/gh-json';

export interface WaitForCIInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
  /**
   * Minimum continuous time (seconds) the rollup must remain "all done and
   * passing" with an unchanged signature before this activity returns
   * `success`. Guards against the GitHub registration race where a fast
   * check (e.g. lint) lands SUCCESS before sibling workflows have appeared
   * in `statusCheckRollup` at all. Default: 60 seconds. With the default
   * `pollIntervalSeconds` of 30, that's at least one full extra poll cycle
   * after the first all-done observation before the merge gate opens.
   */
  minSuccessStabilizationSeconds?: number;
}

/**
 * Terminal statuses observed by `waitForCIActivity`:
 *  - `success`: CI checks have settled with the same all-done-and-passing
 *    signature for at least `minSuccessStabilizationSeconds`. The
 *    stabilization window matters: GitHub registers workflows asynchronously,
 *    so a fast lint job can flash SUCCESS before its siblings have a
 *    check-suite entry — without the wait we'd treat that as the whole
 *    rollup and merge prematurely. Failures are NOT stabilized; the first
 *    fully-settled-with-failure observation returns immediately so self-heal
 *    can run on the next push.
 *  - `failure`: at least one check is done with a non-passing conclusion
 *    and no check is still pending.
 *  - `timeout`: hit `maxWaitSeconds` without a settled rollup.
 *  - `closed`: the PR was closed externally (human cancellation, base
 *    deleted, etc.). The workflow must exit cleanly — no self-heal applies.
 *  - `merged`: the PR was merged externally (e.g. base force-pushed, manual
 *    merge by a reviewer). Treat as a successful early exit.
 *
 * Caveat: stabilization gates *our* call to `gh pr merge --auto`, but once
 * `--auto` is requested GitHub itself merges as soon as branch-protection's
 * required-checks set passes. If the repo only marks a subset of workflows as
 * required, GitHub may merge while non-required checks are still running —
 * that is a branch-protection configuration choice, not something this
 * activity can override.
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
  const minStabilizationMs = (input.minSuccessStabilizationSeconds ?? 60) * 1000;
  const deadline = Date.now() + (input.maxWaitSeconds ?? 60 * 60) * 1000;
  const ctx = Context.current();
  let stabilization: RollupSnapshot | undefined;

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

      if (decision.status === 'failure') {
        // Failures are not stabilized — see docstring above.
        return toCIResult(decision);
      }

      if (decision.status === 'success') {
        const stab = evaluateStabilization(stabilization, checks, Date.now(), minStabilizationMs);
        if (stab.kind === 'settle') {
          if (checks.length === 0) {
            log.info('No CI checks observed during stabilization window — treating as success', {
              pr: input.prNumber,
              stabilizationSeconds: minStabilizationMs / 1000,
            });
          }
          return toCIResult(decision);
        }
        stabilization = stab.next;
      } else {
        // pending → reset the stabilization window; we'll start it over the
        // next time the rollup is fully done and passing.
        stabilization = undefined;
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
