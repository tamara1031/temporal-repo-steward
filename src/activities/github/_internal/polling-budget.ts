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
