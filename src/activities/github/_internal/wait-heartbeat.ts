import { Context } from '@temporalio/activity';
import { sleepCancellable } from './gh-env';

/**
 * Background heartbeat cadence for long-running GitHub waits. This is
 * independent of poll intervals so slow `gh` calls or long sleeps don't trip
 * the activity proxy heartbeat timeout.
 */
const DEFAULT_HEARTBEAT_TICK_MS = 30 * 1000;

export interface GitHubWaitHeartbeatOptions {
  phase: string;
  prNumber: number;
  tickMs?: number;
}

export interface GitHubWaitHeartbeatRuntime {
  sleep: (ms: number) => Promise<void>;
}

export async function withGitHubWaitHeartbeat<T>(
  options: GitHubWaitHeartbeatOptions,
  run: (runtime: GitHubWaitHeartbeatRuntime) => Promise<T>,
): Promise<T> {
  const ctx = Context.current();
  const heartbeatDetails = { phase: options.phase, prNumber: options.prNumber };
  const heartbeatStop = new AbortController();

  ctx.heartbeat(heartbeatDetails);
  const heartbeatTask = (async () => {
    while (!heartbeatStop.signal.aborted) {
      try {
        await sleepUntilHeartbeatTick(
          options.tickMs ?? DEFAULT_HEARTBEAT_TICK_MS,
          ctx.cancellationSignal,
          heartbeatStop.signal,
        );
      } catch {
        return;
      }
      if (heartbeatStop.signal.aborted) return;
      ctx.heartbeat(heartbeatDetails);
    }
  })();

  heartbeatTask.catch(() => undefined);

  try {
    return await run({
      sleep: (ms) => sleepCancellable(ms, ctx.cancellationSignal),
    });
  } finally {
    heartbeatStop.abort();
    await heartbeatTask.catch(() => undefined);
  }
}

function sleepUntilHeartbeatTick(
  ms: number,
  activitySignal: AbortSignal,
  stopSignal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (activitySignal.aborted || stopSignal.aborted) {
      reject(new Error('cancelled'));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('cancelled'));
    };
    const cleanup = (): void => {
      activitySignal.removeEventListener('abort', onAbort);
      stopSignal.removeEventListener('abort', onAbort);
    };

    activitySignal.addEventListener('abort', onAbort, { once: true });
    stopSignal.addEventListener('abort', onAbort, { once: true });
  });
}
