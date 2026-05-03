/**
 * Typed catalog of every ApplicationFailure error type used in this project.
 *
 * ## Why this module exists
 *
 * Error type strings were previously scattered as raw literals across ~8 files.
 * A typo silently changes retry behaviour (a non-retryable error starts retrying,
 * or vice-versa), and adding a new error type requires knowing which proxy configs
 * to update. This module is the single place to look and the single place to
 * change.
 *
 * ## Two classification mechanisms
 *
 * Temporal TypeScript SDK supports two ways to mark an error non-retryable:
 *
 * 1. **Self-classifying** (`ApplicationFailure.nonRetryable(msg, type)`):
 *    Sets `nonRetryable: true` on the thrown object. Temporal honours this flag
 *    regardless of which proxy handles the activity — even proxies that don't
 *    list the type in `nonRetryableErrorTypes`.
 *    Use for errors that should NEVER retry regardless of call site.
 *
 * 2. **Proxy-configured** (`ApplicationFailure.create({ type })` + proxy's
 *    `nonRetryableErrorTypes`):
 *    The proxy's retry policy determines behaviour. The error object itself does
 *    NOT set `nonRetryable: true`.
 *    Use when retry behaviour legitimately differs between proxies (rare), or
 *    when the error comes from a library you can't change.
 *
 * The constants below document which mechanism each error uses. Proxy configs
 * import `PROXY_NON_RETRYABLE` / `ADVISOR_PROXY_NON_RETRYABLE` so that the
 * authoritative list flows from here outward rather than being hardcoded there.
 */

// ---------------------------------------------------------------------------
// Self-classifying non-retryable errors
// Thrown with ApplicationFailure.nonRetryable(msg, type).
// They are also listed in PROXY_NON_RETRYABLE as a redundant safety net in
// case any call site switches to ApplicationFailure.create() in the future.
// ---------------------------------------------------------------------------

/** Codex auth file (~/.codex/auth.json) or GITHUB_TOKEN is missing on the Worker pod. */
export const ERR_MISSING_CREDENTIALS = 'MissingCredentials' as const;

/** A required git ref (e.g. base branch name) is empty or structurally invalid. */
export const ERR_INVALID_GIT_REF = 'InvalidGitRef' as const;

/** GitHub CLI returned a response that cannot be parsed into the expected shape. */
export const ERR_INVALID_GH_OUTPUT = 'InvalidGitHubOutput' as const;

// ---------------------------------------------------------------------------
// Proxy-configured non-retryable errors
// Thrown with ApplicationFailure.create({ type, nonRetryable: false }) (the
// default).  The proxy's nonRetryableErrorTypes list does the classification.
// ---------------------------------------------------------------------------

/**
 * The planner codex call returned output that cannot be parsed as a valid plan
 * JSON object.  A deterministic bad output — re-running the identical prompt
 * won't produce a different result — so retrying is wasteful.  Listed in every
 * proxy's `nonRetryableErrorTypes` via PROXY_NON_RETRYABLE.
 */
export const ERR_PLANNER_OUTPUT_INVALID = 'PlannerOutputInvalid' as const;

/**
 * The advisor codex call returned output that cannot be parsed as a valid verdict
 * JSON object.  Only relevant to the advisor proxy; other proxies never invoke
 * the advisor activity, so they don't need this type in their lists.
 */
export const ERR_ADVISOR_OUTPUT_INVALID = 'AdvisorOutputInvalid' as const;

// ---------------------------------------------------------------------------
// Transient retryable errors — NOT in any nonRetryableErrorTypes list.
// Named here so call sites can import a constant rather than a raw string.
// ---------------------------------------------------------------------------

/**
 * Upstream LLM returned HTTP 429 or a quota-exceeded message.  Temporal retries
 * these with the quota-friendly backoff tuned into the codex proxies.
 */
export const ERR_RATE_LIMITED = 'RateLimited' as const;

/**
 * The codex process exited non-zero for a non-quota reason.  Retryable: transient
 * tool failures (e.g. network blip inside codex) can resolve on the next attempt.
 */
export const ERR_CODEX_INVOCATION = 'CodexInvocationError' as const;

// ---------------------------------------------------------------------------
// Proxy config arrays — imported by proxies.ts
// ---------------------------------------------------------------------------

/**
 * Non-retryable error types that belong in EVERY proxy's `nonRetryableErrorTypes`.
 *
 * Includes both the proxy-configured errors (`PlannerOutputInvalid`) and the
 * self-classifying ones (`MissingCredentials`, `InvalidGitRef`,
 * `InvalidGitHubOutput`) as a belt-and-suspenders guard: if any call site ever
 * switches from `.nonRetryable()` to `.create()`, the proxy config still catches
 * the error correctly.
 */
export const PROXY_NON_RETRYABLE = [
  ERR_MISSING_CREDENTIALS,
  ERR_INVALID_GIT_REF,
  ERR_INVALID_GH_OUTPUT,
  ERR_PLANNER_OUTPUT_INVALID,
] as const;

/**
 * Non-retryable error types for the advisor proxy specifically.
 * Superset of PROXY_NON_RETRYABLE — includes `AdvisorOutputInvalid` which only
 * the advisor activity can throw.
 */
export const ADVISOR_PROXY_NON_RETRYABLE = [
  ...PROXY_NON_RETRYABLE,
  ERR_ADVISOR_OUTPUT_INVALID,
] as const;

// ---------------------------------------------------------------------------
// TypeScript types for exhaustiveness checking at throw sites
// ---------------------------------------------------------------------------

export type ProxyNonRetryable = (typeof PROXY_NON_RETRYABLE)[number];
export type AdvisorProxyNonRetryable = (typeof ADVISOR_PROXY_NON_RETRYABLE)[number];

/** Union of every known error type in this project. */
export type KnownErrorType =
  | typeof ERR_MISSING_CREDENTIALS
  | typeof ERR_INVALID_GIT_REF
  | typeof ERR_INVALID_GH_OUTPUT
  | typeof ERR_PLANNER_OUTPUT_INVALID
  | typeof ERR_ADVISOR_OUTPUT_INVALID
  | typeof ERR_RATE_LIMITED
  | typeof ERR_CODEX_INVOCATION;
