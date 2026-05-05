/**
 * Domain types shared between the step-execution layer
 * (`refactor-step-loop.ts`) and the report renderer (`refactor-report.ts`).
 *
 * ## Why this module exists
 *
 * Previously `StepRecord` and `ParliamentSummary` were defined in
 * `refactor-report.ts` (a presentation module), but `refactor-step-loop.ts`
 * (a business-logic module) imported them from there.  That created an
 * inverted dependency: the business-logic layer depended on the presentation
 * layer to get its own data types.
 *
 * `CircuitBreaker` had the mirror problem: defined in `refactor-step-loop.ts`
 * but `refactor-report.ts` copied the same shape as an inline type.
 *
 * This module is the neutral owner.  Both the producer
 * (`refactor-step-loop.ts`) and the renderer (`refactor-report.ts`) import
 * from here; neither depends on the other for type definitions.
 */

import type { PlanStep, ReviewConcern, ReviewOutput } from '../../activities/refactor';

export interface ParliamentSummary {
  iter: number;
  /** Empty when Parliament was skipped (trivial diff). */
  reviews: { concern: ReviewConcern; verdict: ReviewOutput['verdict']; bullets: string[] }[];
  skipped?: 'trivial-diff';
}

/**
 * Per-step ledger entry retained for the final PR body.  Workflow state stays
 * small — we keep only what the report needs, not raw codex output.
 */
export interface StepRecord {
  step: PlanStep;
  outcome:
    | 'converged'
    | 'parliament-skipped'
    | 'dropped-no-progress'
    | 'dropped-not-converged'
    | 'rolled-back-critical-block';
  iters: number;
  implementReports: string[];
  parliamentSummary: ParliamentSummary[];
  driftReverts: string[];
}

export interface CircuitBreaker {
  step: PlanStep;
  concern: ReviewConcern;
  bullets: string[];
}
