export interface FixedPollTimingDefaults {
  intervalMs: number;
  maxWaitMs: number;
}

export interface AttemptPollTimingDefaults {
  intervalMs: number;
  attempts: number;
  maxWaitMs: number;
}

export const GITHUB_CI_POLL_DEFAULTS = {
  intervalMs: 30 * 1000,
  maxWaitMs: 60 * 60 * 1000,
} satisfies FixedPollTimingDefaults;

export const GITHUB_PR_STATE_POLL_DEFAULTS = {
  intervalMs: 30 * 1000,
  maxWaitMs: 60 * 60 * 1000,
} satisfies FixedPollTimingDefaults;

export const GITHUB_POST_MERGE_POLL_DEFAULTS = {
  intervalMs: 10_000,
  attempts: 6,
  maxWaitMs: 4 * 60 * 1000,
} satisfies AttemptPollTimingDefaults;

export function normalizePollIntervalMs(intervalMs: number, defaultIntervalMs: number): number {
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    return intervalMs;
  }
  return Number.isFinite(defaultIntervalMs) && defaultIntervalMs > 0 ? defaultIntervalMs : 1;
}

export interface PollTimingOptions {
  nowMs: number;
  intervalMs: number;
  defaultIntervalMs: number;
  maxWaitMs: number;
}

export interface PollTiming {
  intervalMs: number;
  deadlineMs: number;
}

export function normalizePollTiming(options: PollTimingOptions): PollTiming {
  return {
    intervalMs: normalizePollIntervalMs(options.intervalMs, options.defaultIntervalMs),
    deadlineMs: options.nowMs + options.maxWaitMs,
  };
}

export interface PollTimingWithDefaultsOptions {
  nowMs: number;
  intervalMs?: number;
  maxWaitMs?: number;
  defaults: FixedPollTimingDefaults;
}

export function normalizePollTimingWithDefaults(
  options: PollTimingWithDefaultsOptions,
): PollTiming {
  return normalizePollTiming({
    nowMs: options.nowMs,
    intervalMs: options.intervalMs ?? options.defaults.intervalMs,
    defaultIntervalMs: options.defaults.intervalMs,
    maxWaitMs: options.maxWaitMs ?? options.defaults.maxWaitMs,
  });
}

export interface AttemptPollTimingOptions {
  nowMs: number;
  intervalMs: number;
  defaultIntervalMs: number;
  attempts: number;
  maxWaitMs: number;
}

export function normalizeAttemptPollTiming(options: AttemptPollTimingOptions): PollTiming {
  const intervalMs = normalizePollIntervalMs(options.intervalMs, options.defaultIntervalMs);
  return {
    intervalMs,
    deadlineMs: options.nowMs + Math.min(options.attempts * intervalMs, options.maxWaitMs),
  };
}

export interface AttemptPollTimingWithDefaultsOptions {
  nowMs: number;
  intervalMs?: number;
  attempts?: number;
  maxWaitMs?: number;
  defaults: AttemptPollTimingDefaults;
}

export interface NormalizedAttemptPollTiming extends PollTiming {
  attempts: number;
}

export function normalizeAttemptPollTimingWithDefaults(
  options: AttemptPollTimingWithDefaultsOptions,
): NormalizedAttemptPollTiming {
  const attempts = normalizePollAttempts(options.attempts, options.defaults.attempts);
  const maxWaitMs = normalizeNonNegativePollWaitMs(options.maxWaitMs, options.defaults.maxWaitMs);
  return {
    ...normalizeAttemptPollTiming({
      nowMs: options.nowMs,
      intervalMs: options.intervalMs ?? options.defaults.intervalMs,
      defaultIntervalMs: options.defaults.intervalMs,
      attempts,
      maxWaitMs,
    }),
    attempts,
  };
}

export function normalizePollAttempts(attempts: number | undefined, defaultAttempts: number): number {
  return Math.max(1, Math.floor(attempts ?? defaultAttempts));
}

export function normalizeNonNegativePollWaitMs(
  waitMs: number | undefined,
  defaultWaitMs: number,
): number {
  return Math.max(0, Math.floor(waitMs ?? defaultWaitMs));
}

export function nextPollSleepMs(
  deadlineMs: number,
  nowMs: number,
  intervalMs: number,
): number | undefined {
  const remainingMs = deadlineMs - nowMs;
  if (remainingMs <= 0) {
    return undefined;
  }
  return Math.min(intervalMs, remainingMs);
}

export type PollStepResult<T> =
  | { done: true; value: T }
  | { done: false };

export interface PollWithBudgetOptions<T> {
  intervalMs: number;
  defaultIntervalMs: number;
  deadlineMs: number | ((normalizedIntervalMs: number) => number);
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  observe: () => Promise<PollStepResult<T>>;
  onTimeout: () => T;
  maxAttempts?: number;
  observeAtDeadline?: boolean;
}

export async function pollWithBudget<T>(options: PollWithBudgetOptions<T>): Promise<T> {
  const intervalMs = normalizePollIntervalMs(options.intervalMs, options.defaultIntervalMs);
  const deadlineMs =
    typeof options.deadlineMs === 'function' ? options.deadlineMs(intervalMs) : options.deadlineMs;
  const maxAttempts =
    options.maxAttempts === undefined
      ? undefined
      : Math.max(1, Math.floor(options.maxAttempts));
  let attempts = 0;

  while (maxAttempts === undefined || attempts < maxAttempts) {
    if (!options.observeAtDeadline && options.now() >= deadlineMs) {
      return options.onTimeout();
    }

    attempts += 1;
    const result = await options.observe();
    if (result.done) {
      return result.value;
    }

    if (maxAttempts !== undefined && attempts >= maxAttempts) {
      return options.onTimeout();
    }

    const sleepMs = nextPollSleepMs(deadlineMs, options.now(), intervalMs);
    if (sleepMs === undefined) {
      return options.onTimeout();
    }
    await options.sleep(sleepMs);
  }

  return options.onTimeout();
}
