import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities';

const NON_RETRYABLE = ['MissingCredentials', 'InvalidGitRef', 'PlannerOutputInvalid'] as const;

/** Short, idempotent calls (gh read-only, git plumbing, status updates). */
export const cheap = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: {
    initialInterval: '2s',
    backoffCoefficient: 2,
    maximumInterval: '30s',
    maximumAttempts: 5,
    nonRetryableErrorTypes: [...NON_RETRYABLE],
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
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  },
});

/**
 * Per-role codex proxies. Each role has its own timeout because a hung
 * planner / reviewer should not consume an implementer-sized budget. Heartbeats
 * happen every 5s inside `execCommand`, so heartbeat timeouts stay tight.
 *
 * Retry counts are 1 (single attempt) for plan/review — re-running them on
 * failure rarely produces a different outcome and costs another codex call;
 * the workflow handles parser-level retries explicitly. Implementer keeps
 * 2 attempts because transient codex / network errors are common over a
 * 30-minute window.
 */
export const planCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '15s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 1,
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  },
});

export const implementCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '15s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 2,
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  },
});

export const reviewCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '1 minute',
  retry: {
    initialInterval: '15s',
    backoffCoefficient: 2,
    maximumInterval: '2 minutes',
    maximumAttempts: 1,
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  },
});

/**
 * Generic codex Activity (used by pr-lifecycle for CI self-heal and merge
 * conflict resolution). These are still single-shot codex calls but with the
 * larger timeout the legacy orchestrator needed; OK to keep generous since
 * the refactor pipeline no longer routes through this proxy.
 */
export const heavyCodex = proxyActivities<typeof activities>({
  startToCloseTimeout: '90 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    initialInterval: '30s',
    backoffCoefficient: 2,
    maximumInterval: '5 minutes',
    maximumAttempts: 2,
    nonRetryableErrorTypes: [...NON_RETRYABLE],
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
    nonRetryableErrorTypes: [...NON_RETRYABLE],
  },
});
