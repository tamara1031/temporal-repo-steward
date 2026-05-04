import {
  decideCIStatus,
  evaluateStabilization,
  parseStatusCheckRollupJSON,
  type CompletedCIDecision,
  type RollupSnapshot,
} from './ci-rollup';
import { nextPollSleepMs } from './polling-budget';

export interface CIResult {
  status: 'success' | 'failure' | 'timeout' | 'closed' | 'merged';
  failedRunIds: string[];
  failedJobNames: string[];
}

export type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PRWithChecks {
  state: PRState;
  checksJson: string;
}

export interface WaitForCIPollOptions {
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
  minSuccessStabilizationSeconds?: number;
}

export interface WaitForCIPollDeps {
  observe: () => Promise<PRWithChecks>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onExternallyClosed?: () => void;
  onExternallyMerged?: () => void;
  onNoChecksSettled?: (stabilizationSeconds: number) => void;
}

export async function pollCIStatus(
  input: WaitForCIPollOptions,
  deps: WaitForCIPollDeps,
): Promise<CIResult> {
  const interval = (input.pollIntervalSeconds ?? 30) * 1000;
  const minStabilizationMs = (input.minSuccessStabilizationSeconds ?? 60) * 1000;
  const deadline = deps.now() + (input.maxWaitSeconds ?? 60 * 60) * 1000;
  let stabilization: RollupSnapshot | undefined;

  while (deps.now() < deadline) {
    const observed = await deps.observe();
    if (observed.state === 'CLOSED') {
      deps.onExternallyClosed?.();
      return { status: 'closed', failedRunIds: [], failedJobNames: [] };
    }
    if (observed.state === 'MERGED') {
      deps.onExternallyMerged?.();
      return { status: 'merged', failedRunIds: [], failedJobNames: [] };
    }

    const checks = parseStatusCheckRollupJSON(observed.checksJson);
    const decision = decideCIStatus(checks);

    if (decision.status === 'failure') {
      return toCIResult(decision);
    }

    if (decision.status === 'success') {
      const stab = evaluateStabilization(stabilization, checks, deps.now(), minStabilizationMs);
      if (stab.kind === 'settle') {
        if (checks.length === 0) {
          deps.onNoChecksSettled?.(minStabilizationMs / 1000);
        }
        return toCIResult(decision);
      }
      stabilization = stab.next;
    } else {
      stabilization = undefined;
    }

    const sleepMs = nextPollSleepMs(deadline, deps.now(), interval);
    if (sleepMs === undefined) {
      break;
    }
    await deps.sleep(sleepMs);
  }

  return { status: 'timeout', failedRunIds: [], failedJobNames: [] };
}

function toCIResult(decision: CompletedCIDecision): CIResult {
  return {
    status: decision.status,
    failedRunIds: decision.failedRunIds,
    failedJobNames: decision.failedJobNames,
  };
}
