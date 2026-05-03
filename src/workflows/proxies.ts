import { proxyActivities } from '@temporalio/workflow';
import type { RetryPolicy } from '@temporalio/common';
import type * as activities from '../activities';
import { PROXY_NON_RETRYABLE, ADVISOR_PROXY_NON_RETRYABLE } from '../errors';

/** Short, idempotent calls (gh read-only, git plumbing, status updates). */
export const cheap = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
    nonRetryableErrorTypes: [...PROXY_NON_RETRYABLE],
  },
});

/** Heavy or external work (clone, push). */
export const heavy = proxyActivities<typeof activities>({
  startToCloseTimeout: '20 minutes',
  retry: {
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 4,
    nonRetryableErrorTypes: [...PROXY_NON_RETRYABLE],
  },
});

/**
 * Quota-friendly retry policy for codex (LLM-bound) activities. Designed for
 * 429 / rate-limit handling: high backoff coefficient, long max interval, more
 * attempts. The `runCodexExec` helper classifies upstream rate limits as the
 * retryable `RateLimited` error type — Temporal's RetryPolicy is single-config
 * (no per-error-type backoff), so we tune the whole policy assuming any retry
 * MAY be a quota retry. Non-quota CodexInvocationErrors retry under the same
 * (still tolerable) curve.
 *
 * 5 attempts × backoffCoefficient 3 × initialInterval 30s caps total wait at
 * roughly: 30s + 90s + 270s + 600s (capped) + 600s = ~26 min before giving up.
 */
const codexQuotaFriendlyRetry: RetryPolicy = {
  initialInterval: '30s',
  backoffCoefficient: 3,
  maximumInterval: '10 minutes',
  maximumAttempts: 5,
  nonRetryableErrorTypes: [...PROXY_NON_RETRYABLE],
};

/**
 * Per-role codex proxies. Each role has its own startToCloseTimeout because a
 * hung planner / reviewer should not consume an implementer-sized budget.
 * Heartbeats happen every 5s inside `execCommand`, so heartbeat timeouts stay
 * tight.
 *
 * All four LLM proxies share the same `codexQuotaFriendlyRetry` policy so a
 * 429 anywhere in the pipeline backs off rather than failing fast.
 */
export const contextCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: codexQuotaFriendlyRetry,
});

export const planCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: codexQuotaFriendlyRetry,
});

export const implementCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: codexQuotaFriendlyRetry,
});

export const reviewCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: codexQuotaFriendlyRetry,
});

/**
 * Generic codex Activity (used by pr-lifecycle for CI self-heal and merge
 * conflict resolution). Single-shot codex calls but with the larger timeout
 * the legacy orchestrator needed; OK to keep generous since the refactor
 * pipeline no longer routes through this proxy.
 */
export const heavyCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '90 minutes',
  heartbeatTimeout: '2 minutes',
  retry: codexQuotaFriendlyRetry,
});

/**
 * Advisor proxy — single-shot escalation. Tight timeout (the input is
 * pre-summarized, so the call itself is small). Few attempts: if the advisor
 * itself fails twice, falling back to a deterministic default is safer than
 * looping. `RateLimited` is still retryable through the shared policy.
 */
export const advisor = proxyActivities<typeof activities>({
  startToCloseTimeout: '4 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '20s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...ADVISOR_PROXY_NON_RETRYABLE],
  },
});

/** Long-running CI poll. The activity heartbeats; workflow timer is unused. */
export const ciWait = proxyActivities<typeof activities>({
  startToCloseTimeout: '70 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '15s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 3,
    nonRetryableErrorTypes: [...PROXY_NON_RETRYABLE],
  },
});
