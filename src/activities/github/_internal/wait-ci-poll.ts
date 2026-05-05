import {
  decideCIStatus,
  evaluateStabilization,
  parseStatusCheckRollupJSON,
  type CompletedCIDecision,
  type RollupSnapshot,
} from './ci-rollup';
import {
  GITHUB_CI_POLL_DEFAULTS,
  normalizePollTimingWithDefaults,
  pollWithBudget,
} from './polling-budget';

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
  const minStabilizationMs = (input.minSuccessStabilizationSeconds ?? 60) * 1000;
  const timing = normalizePollTimingWithDefaults({
    nowMs: deps.now(),
    intervalMs:
      input.pollIntervalSeconds === undefined ? undefined : input.pollIntervalSeconds * 1000,
    maxWaitMs: input.maxWaitSeconds === undefined ? undefined : input.maxWaitSeconds * 1000,
    defaults: GITHUB_CI_POLL_DEFAULTS,
  });
  let stabilization: RollupSnapshot | undefined;

  return pollWithBudget<CIResult>({
    intervalMs: timing.intervalMs,
    defaultIntervalMs: GITHUB_CI_POLL_DEFAULTS.intervalMs,
    deadlineMs: timing.deadlineMs,
    now: deps.now,
    sleep: deps.sleep,
    observe: async () => {
      const observed = await deps.observe();
      if (observed.state === 'CLOSED') {
        deps.onExternallyClosed?.();
        return { done: true, value: { status: 'closed', failedRunIds: [], failedJobNames: [] } };
      }
      if (observed.state === 'MERGED') {
        deps.onExternallyMerged?.();
        return { done: true, value: { status: 'merged', failedRunIds: [], failedJobNames: [] } };
      }

      const checks = parseStatusCheckRollupJSON(observed.checksJson);
      const decision = decideCIStatus(checks);

      if (decision.status === 'failure') {
        return { done: true, value: toCIResult(decision) };
      }

      if (decision.status === 'success') {
        const stab = evaluateStabilization(stabilization, checks, deps.now(), minStabilizationMs);
        if (stab.kind === 'settle') {
          if (checks.length === 0) {
            deps.onNoChecksSettled?.(minStabilizationMs / 1000);
          }
          return { done: true, value: toCIResult(decision) };
        }
        stabilization = stab.next;
      } else {
        stabilization = undefined;
      }

      return { done: false };
    },
    onTimeout: () => ({ status: 'timeout', failedRunIds: [], failedJobNames: [] }),
  });
}

function toCIResult(decision: CompletedCIDecision): CIResult {
  return {
    status: decision.status,
    failedRunIds: decision.failedRunIds,
    failedJobNames: decision.failedJobNames,
  };
}
