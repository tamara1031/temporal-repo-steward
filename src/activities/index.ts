/**
 * Worker-facing barrel. The Temporal worker registers every async function
 * exported from this file as an Activity. Each Activity lives in its own file
 * inside one of the cluster directories below; helpers (non-Activity
 * functions) live under each cluster's `_internal/` subdirectory and are NOT
 * re-exported here.
 *
 * Cluster map:
 *   - advisor/    single-shot escalation hop to a stronger model
 *                 (`consultAdvisorActivity`)
 *   - codex/      generic single-shot codex Activity (`codexActivity`)
 *   - git/        workspace + git-plumbing activities (clone, commit, push,
 *                 check-conflict, cleanup, diff-stat, diff-text,
 *                 status-porcelain, restore)
 *   - github/     `gh` CLI activities (create-pr, wait-for-ci,
 *                 fetch-failed-logs, merge-pr, observe-pr-state)
 *   - refactor/   codex role activities for the periodic pipeline
 *                 (extract-context, plan, implement, review)
 */

export {
  cloneRepoActivity,
  commitAllActivity,
  pushBranchActivity,
  checkConflictActivity,
  cleanupWorkspaceActivity,
  diffStatActivity,
  diffTextActivity,
  statusPorcelainActivity,
  restoreActivity,
  snapshotWorkdirActivity,
  popWorkdirSnapshotActivity,
} from './git';
export {
  createPRActivity,
  waitForCIActivity,
  fetchFailedRunLogsActivity,
  mergePRActivity,
  observePRStateActivity,
} from './github';
export type {
  PRInfo,
  CIResult,
  ObservePRStateOutput,
  PRLifecycleState,
} from './github';
export type { CheckConflictOutput } from './git';
export { codexActivity } from './codex';
export type { CodexInput, CodexOutput } from './codex';
export { consultAdvisorActivity } from './advisor';
export type {
  ConsultAdvisorInput,
  ConsultAdvisorOutput,
  AdvisorVerdict,
} from './advisor';
export {
  extractContextArtifactActivity,
  planActivity,
  implementActivity,
  reviewActivity,
  reviewPlanActivity,
  refinePlanActivity,
} from './refactor';
export type {
  ContextArtifact,
  ExtractContextInput,
  PlanInput,
  PlanOutput,
  PlanStep,
  ImplementInput,
  ImplementOutput,
  ReviewInput,
  ReviewOutput,
  ReviewConcern,
  ReviewPlanInput,
  PlanReviewOutput,
  PlanReviewConcern,
  RefinePlanInput,
  DesignRound,
  DesignPhaseRecord,
} from './refactor';
