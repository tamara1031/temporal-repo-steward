/**
 * Shared types for the `refactor/` activity cluster. Keeping types in one
 * file lets each activity file (`extract-context.ts`, `plan.ts`, `implement.ts`,
 * `review.ts`) import a tight set rather than re-declare or cross-import.
 */

/**
 * Repository-level summary distilled once at workflow init. Threaded through
 * every role prompt as part of the "static" (cacheable) preamble so the LLM
 * provider's prompt cache hits across plan / implement / review activities
 * within a single workflow run.
 */
export interface ContextArtifact {
  /** Repo overview: top-level layout, package manifest summary, central modules. */
  overview: string;
  /** Coding conventions / invariants / things future steps must respect. Bullets. */
  conventions: string[];
  /** Stable interface signatures or shared types worth knowing about. Bullets. */
  interfaces: string[];
  /** ISO timestamp the artifact was generated (workflow-deterministic when set by caller). */
  generatedAt: string;
}

export interface PlanStep {
  title: string;
  description: string;
  critical_requirements: string[];
}

export interface PlanOutput {
  theme: string;
  rationale: string;
  steps: PlanStep[];
}

export type ReviewConcern = 'correctness' | 'quality';

export interface ReviewOutput {
  verdict: 'ok' | 'needs_revision' | 'critical_block';
  blocking_issues: string[];
  suggestions: string[];
}

export type PlanReviewConcern = 'feasibility' | 'scope';

export interface PlanReviewOutput {
  verdict: 'ok' | 'needs_revision';
  blocking_issues: string[];
  suggestions: string[];
}

export interface DesignRound {
  iter: number;
  reviews: { concern: PlanReviewConcern; verdict: PlanReviewOutput['verdict']; bullets: string[] }[];
}

export interface DesignPhaseRecord {
  rounds: DesignRound[];
  outcome: 'converged' | 'single-shot' | 'dropped-no-progress' | 'max-rounds';
  iters: number;
}
