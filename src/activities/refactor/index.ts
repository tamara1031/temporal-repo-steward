/**
 * refactor/ cluster — codex role activities for the periodic refactor pipeline.
 * Each role (context extractor / planner / implementer / reviewer) is its own
 * file. Shared types, prompts, and parsers live in `_internal/`.
 *
 * The workflow in `src/workflows/periodic.ts` orchestrates these — codex CLI
 * does no internal subagent spawning. This gives:
 *   - Visibility: each role is one event in the Temporal UI.
 *   - Transparency: each prompt + result is logged separately by Temporal.
 *   - Reproducibility: workflow logic is deterministic; role activities are
 *     the only non-deterministic units, and they're independently retryable.
 *   - Token savings: no orchestrator-prompt overhead, each call is tight.
 */

export { extractContextArtifactActivity } from './extract-context';
export type { ExtractContextInput } from './extract-context';

export { planActivity } from './plan';
export type { PlanInput } from './plan';

export { implementActivity } from './implement';
export type { ImplementInput, ImplementOutput } from './implement';

export { reviewActivity } from './review';
export type { ReviewInput } from './review';

export { reviewPlanActivity } from './review-plan';
export type { ReviewPlanInput } from './review-plan';

export { refinePlanActivity } from './refine-plan';
export type { RefinePlanInput } from './refine-plan';

export type {
  ContextArtifact,
  PlanOutput,
  PlanStep,
  ReviewConcern,
  ReviewOutput,
  PlanReviewConcern,
  PlanReviewOutput,
  DesignRound,
  DesignPhaseRecord,
} from './_internal/types';
