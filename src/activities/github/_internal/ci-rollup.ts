import { invalidGhOutput, isRecord, parseGhJSON } from './gh-json';

export interface RollupCheck {
  name: string;
  // CheckRun: COMPLETED|IN_PROGRESS|QUEUED|PENDING|REQUESTED.
  // StatusContext: PENDING|SUCCESS|ERROR|FAILURE|EXPECTED.
  state?: string;
  // CheckRun: SUCCESS|FAILURE|NEUTRAL|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STALE|SKIPPED|STARTUP_FAILURE.
  conclusion?: string;
  workflowName?: string;
  detailsUrl?: string;
}

interface CIResultFields {
  failedRunIds: string[];
  failedJobNames: string[];
}

export type CIDecision =
  | ({ status: 'success' } & CIResultFields)
  | ({ status: 'failure' } & CIResultFields)
  | ({ status: 'pending' } & CIResultFields);

export type CompletedCIDecision = Extract<CIDecision, { status: 'success' | 'failure' }>;

interface CheckOutcome {
  done: boolean;
  passed: boolean;
}

const TERMINAL_STATUS_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR']);
const PASSING_OUTCOMES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE']);

export function parseStatusCheckRollupJSON(stdout: string): RollupCheck[] {
  const data = parseGhJSON(stdout, 'gh pr view --json statusCheckRollup');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json statusCheckRollup output must be a JSON object');
  }
  if (data.statusCheckRollup === undefined) {
    return [];
  }
  if (!Array.isArray(data.statusCheckRollup)) {
    throw invalidGhOutput(
      'gh pr view --json statusCheckRollup output field "statusCheckRollup" must be an array',
    );
  }
  return data.statusCheckRollup.map((check, index) => parseRollupCheck(check, index));
}

export function classifyCheck(check: RollupCheck): CheckOutcome {
  // CheckRun objects expose `conclusion` once the run finishes.
  if (check.conclusion) {
    return { done: true, passed: PASSING_OUTCOMES.has(check.conclusion) };
  }
  // StatusContext objects only expose `state`. PENDING / EXPECTED means in flight.
  if (check.state && TERMINAL_STATUS_STATES.has(check.state)) {
    return { done: true, passed: check.state === 'SUCCESS' };
  }
  return { done: false, passed: false };
}

export function extractRunId(detailsUrl?: string): string | undefined {
  if (!detailsUrl) return undefined;
  // Sample: https://github.com/owner/repo/actions/runs/1234567890/job/9876543210
  const m = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : undefined;
}

export interface RollupSnapshot {
  /**
   * Sorted `${name}\0${conclusion ?? state ?? ''}` tuples for every check in
   * the rollup. Capturing both identity AND verdict means a re-run that
   * keeps the same job name still flips the signature (`SUCCESS` →
   * `IN_PROGRESS`) and resets the stabilization timer.
   */
  signature: string[];
  /** Wall-clock ms when this signature first appeared. */
  firstObservedAt: number;
}

export type StabilizationDecision =
  | { kind: 'wait'; next: RollupSnapshot }
  | { kind: 'settle' };

/**
 * Should the caller treat the current rollup as "actually green now"?
 *
 * Naïve "all checks done & passing → merge" is racy: GitHub registers each
 * triggered workflow asynchronously, so a fast lint check can land SUCCESS
 * in `statusCheckRollup` before the sibling workflows even have a check-suite
 * entry. Trusting that snapshot is the "merges as soon as one CI turns green"
 * pathology this guard exists to prevent.
 *
 * Stabilization rule: the *same* signature must persist for at least
 * `minStabilizationMs` continuous milliseconds. ANY change — a new check
 * appearing, an existing check transitioning between conclusions, a re-run —
 * restarts the clock.
 *
 * Failure is intentionally NOT stabilized: callers short-circuit on
 * `decideCIStatus(...).status === 'failure'` so self-heal kicks in promptly
 * instead of burning another polling window on a known-bad rollup. The next
 * push retriggers everything anyway.
 */
export function evaluateStabilization(
  prev: RollupSnapshot | undefined,
  checks: readonly RollupCheck[],
  nowMs: number,
  minStabilizationMs: number,
): StabilizationDecision {
  const signature = checks
    .map((c) => `${c.name}\0${c.conclusion ?? c.state ?? ''}`)
    .sort();
  if (!prev || !signaturesEqual(prev.signature, signature)) {
    return { kind: 'wait', next: { signature, firstObservedAt: nowMs } };
  }
  if (nowMs - prev.firstObservedAt >= minStabilizationMs) {
    return { kind: 'settle' };
  }
  return { kind: 'wait', next: prev };
}

function signaturesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function decideCIStatus(checks: RollupCheck[]): CIDecision {
  if (checks.length === 0) {
    return { status: 'success', failedRunIds: [], failedJobNames: [] };
  }

  const outcomes = checks.map((check) => ({ check, outcome: classifyCheck(check) }));
  const allDone = outcomes.every((item) => item.outcome.done);

  if (!allDone) {
    return { status: 'pending', failedRunIds: [], failedJobNames: [] };
  }

  const failed = outcomes.filter((item) => !item.outcome.passed).map((item) => item.check);
  if (failed.length === 0) {
    return { status: 'success', failedRunIds: [], failedJobNames: [] };
  }

  return {
    status: 'failure',
    failedRunIds: Array.from(
      new Set(failed.map((check) => extractRunId(check.detailsUrl)).filter(Boolean) as string[]),
    ),
    failedJobNames: failed.map((check) => check.name),
  };
}

function parseRollupCheck(value: unknown, index: number): RollupCheck {
  if (!isRecord(value)) {
    throw invalidGhOutput(`statusCheckRollup[${index}] must be a JSON object`);
  }
  if (typeof value.name !== 'string') {
    throw invalidGhOutput(`statusCheckRollup[${index}] is missing string field "name"`);
  }
  const check: RollupCheck = { name: value.name };
  addOptionalString(check, 'state', value.state, `statusCheckRollup[${index}].state`);
  addOptionalString(check, 'conclusion', value.conclusion, `statusCheckRollup[${index}].conclusion`);
  addOptionalString(
    check,
    'workflowName',
    value.workflowName,
    `statusCheckRollup[${index}].workflowName`,
  );
  addOptionalString(
    check,
    'detailsUrl',
    value.detailsUrl,
    `statusCheckRollup[${index}].detailsUrl`,
  );
  return check;
}

function addOptionalString(
  check: RollupCheck,
  key: keyof Pick<RollupCheck, 'state' | 'conclusion' | 'workflowName' | 'detailsUrl'>,
  value: unknown,
  fieldName: string,
): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'string') {
    throw invalidGhOutput(`${fieldName} must be a string when present`);
  }
  check[key] = value;
}
