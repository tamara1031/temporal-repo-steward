/**
 * github/ cluster — `gh` CLI activities. Each activity is a single file.
 * Helpers (env, JSON parsing, CI rollup, PR view) are in `_internal/`.
 */

export { createPRActivity } from './create-pr';
export type { CreatePRInput, PRInfo } from './create-pr';

export { waitForCIActivity } from './wait-for-ci';
export type { WaitForCIInput, CIResult } from './wait-for-ci';

export { fetchFailedRunLogsActivity } from './fetch-failed-logs';
export type { FetchFailedLogsInput } from './fetch-failed-logs';

export { mergePRActivity } from './merge-pr';
export type { MergePRInput } from './merge-pr';

export { observePRStateActivity, parsePRStateJSON } from './observe-pr-state';
export type {
  ObservePRStateInput,
  ObservePRStateOutput,
  PRLifecycleState,
} from './observe-pr-state';

export { waitForPostMergeActivity, mapPostMergeStateToOutcome } from './wait-for-post-merge';
export type { WaitForPostMergeInput, PostMergeOutcome } from './wait-for-post-merge';

export { waitForPRStateActivity } from './wait-for-pr-state';
export type { WaitForPRStateInput, WaitForPRStateOutput } from './wait-for-pr-state';

// Internal helpers re-exported for the rare consumer that needs them
// (e.g. tests parsing rollup JSON). NOT re-exported from the activities barrel.
export {
  decideCIStatus,
  parseStatusCheckRollupJSON,
  type RollupCheck,
  type CIDecision,
  type CompletedCIDecision,
} from './_internal/ci-rollup';
export { parsePRViewJSON, type PRViewJSON } from './_internal/pr-view';
