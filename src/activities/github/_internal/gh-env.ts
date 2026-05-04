import { ApplicationFailure } from '@temporalio/activity';
import * as os from 'os';
import { ERR_MISSING_CREDENTIALS } from '../../../errors';

/**
 * Build env that lets `gh` CLI authenticate. Both env names are set so the
 * subprocess works regardless of which one its libgh resolution prefers.
 */
export function ghEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN env var is missing on the worker',
      ERR_MISSING_CREDENTIALS,
    );
  }
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? os.tmpdir(),
  };
}

/**
 * Cancellation-aware sleep — used by `wait-for-ci`'s polling loop. Resolves
 * after `ms` or rejects with the abort reason if the activity is cancelled.
 */
export function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
