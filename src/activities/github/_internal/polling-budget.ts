export function normalizePollIntervalMs(intervalMs: number, defaultIntervalMs: number): number {
  if (Number.isFinite(intervalMs) && intervalMs > 0) {
    return intervalMs;
  }
  return Number.isFinite(defaultIntervalMs) && defaultIntervalMs > 0 ? defaultIntervalMs : 1;
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
