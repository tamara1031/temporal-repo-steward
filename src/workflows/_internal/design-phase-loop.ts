/**
 * Design parliament loop: plan → parallel reviewers → refiner → repeat.
 *
 * Lifted into `_internal/` for the same reason as `refactor-step-loop.ts`:
 * the loop logic is reusable from non-periodic orchestrators, and keeping
 * it separate makes `design-phase.ts` read top-to-bottom as intents.
 *
 * Return kinds:
 *   - `completed`          — plan is ready (converged, single-shot, or max-rounds)
 *   - `no-op`              — planner returned theme='no-op' or empty steps
 *   - `plan-failed`        — planner threw a non-retryable error
 *   - `budget-exhausted`   — not enough budget to call the planner
 *
 * Determinism: only Activity proxies and `log` are used. Safe to call from
 * any workflow file.
 */

import { log } from '@temporalio/workflow';
import { planCodex } from '../proxies';
import type { ContextArtifact, DesignPhaseRecord, DesignRound, PlanOutput, PlanReviewConcern, PlanStep } from '../../activities/refactor';
import type { SpawnCounter } from './spawn-budget';

// ──────────────────────────────────────────────────────────────────────────
// Structural equality helpers for PlanOutput
// ──────────────────────────────────────────────────────────────────────────

/**
 * Field-by-field equality for `PlanOutput`. Used instead of
 * `JSON.stringify(a) === JSON.stringify(b)` to avoid sensitivity to key
 * insertion order (which V8 currently preserves but is not part of the spec).
 */
function stepsEqual(a: readonly PlanStep[], b: readonly PlanStep[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa.title !== sb.title || sa.description !== sb.description) return false;
    const ra = sa.critical_requirements;
    const rb = sb.critical_requirements;
    if (ra.length !== rb.length) return false;
    for (let j = 0; j < ra.length; j++) {
      if (ra[j] !== rb[j]) return false;
    }
    const ta = sa.target_files;
    const tb = sb.target_files;
    if (ta === undefined || tb === undefined) {
      if (ta !== tb) return false;
    } else {
      if (ta.length !== tb.length) return false;
      for (let j = 0; j < ta.length; j++) {
        if (ta[j] !== tb[j]) return false;
      }
    }
  }
  return true;
}

function plansEqual(a: PlanOutput, b: PlanOutput): boolean {
  return a.theme === b.theme && a.rationale === b.rationale && stepsEqual(a.steps, b.steps);
}

export interface DesignPhaseConfig {
  /**
   * Number of parliament review-and-refine rounds after the initial plan.
   * 0 = single-shot (no parliament — equivalent to the old planActivity call).
   */
  maxRounds: number;
  /** Reviewer concerns dispatched in parallel each round. */
  reviewerConcerns: readonly PlanReviewConcern[];
}

export const DEFAULT_DESIGN_PHASE_CONFIG: DesignPhaseConfig = {
  maxRounds: 1,
  reviewerConcerns: ['feasibility', 'scope'],
};

export type DesignPhaseLoopResult =
  | { outcome: 'completed'; plan: PlanOutput; record: DesignPhaseRecord }
  | { outcome: 'no-op'; plan: PlanOutput; record: DesignPhaseRecord }
  | { outcome: 'plan-failed' }
  | { outcome: 'budget-exhausted' };

export interface DesignPhaseLoopInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  brief?: string;
  spawnCounter: SpawnCounter;
  config: DesignPhaseConfig;
}

export async function runDesignPhase(input: DesignPhaseLoopInput): Promise<DesignPhaseLoopResult> {
  const { workdir, contextArtifact, brief, spawnCounter, config } = input;
  const { maxRounds, reviewerConcerns } = config;

  if (!spawnCounter.canConsume(1)) {
    log.warn('design spawn budget exhausted before planner; skipping design phase');
    return { outcome: 'budget-exhausted' };
  }
  spawnCounter.consume('planner', 1);

  let plan: PlanOutput;
  try {
    plan = await planCodex.planActivity({ workdir, contextArtifact, brief });
  } catch (err) {
    log.warn('planner failed; design phase returning plan-failed', { err: String(err) });
    return { outcome: 'plan-failed' };
  }

  const record: DesignPhaseRecord = { rounds: [], outcome: 'single-shot', iters: 0 };

  if (plan.theme === 'no-op' || plan.steps.length === 0) {
    return { outcome: 'no-op', plan, record };
  }

  if (maxRounds === 0) {
    return { outcome: 'completed', plan, record };
  }

  for (let iter = 0; iter < maxRounds; iter++) {
    record.iters = iter + 1;

    if (!spawnCounter.canConsume(reviewerConcerns.length)) {
      log.warn('design spawn budget too low for parliament; accepting current plan', {
        iter,
        remaining: spawnCounter.remaining(),
        needed: reviewerConcerns.length,
      });
      record.outcome = 'max-rounds';
      break;
    }
    spawnCounter.consume('plan-reviewer', reviewerConcerns.length);

    const reviews = await Promise.all(
      reviewerConcerns.map((concern) =>
        planCodex.reviewPlanActivity({ workdir, contextArtifact, plan, concern }),
      ),
    );

    const round: DesignRound = {
      iter,
      reviews: reviews.map((r, i) => ({
        concern: reviewerConcerns[i],
        verdict: r.verdict,
        bullets: [...r.blocking_issues, ...r.suggestions].slice(0, 3),
      })),
    };
    record.rounds.push(round);

    if (reviews.every((r) => r.verdict === 'ok')) {
      record.outcome = 'converged';
      break;
    }

    const feedback: string[] = [];
    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      const tag = reviewerConcerns[i];
      for (const issue of r.blocking_issues) feedback.push(`[${tag}] ${issue}`);
      for (const sugg of r.suggestions.slice(0, 2)) feedback.push(`[${tag}] ${sugg}`);
    }

    if (!spawnCounter.canConsume(1)) {
      log.warn('design spawn budget too low for plan refiner; accepting current plan', { iter });
      record.outcome = 'max-rounds';
      break;
    }
    spawnCounter.consume('plan-refiner', 1);

    const planBefore = plan;
    try {
      plan = await planCodex.refinePlanActivity({ workdir, contextArtifact, plan, feedback });
    } catch (err) {
      log.warn('plan refiner failed; accepting pre-refinement plan', { iter, err: String(err) });
      record.outcome = 'max-rounds';
      break;
    }

    if (plansEqual(planBefore, plan)) {
      log.info('plan refiner made no changes; accepting current plan', { iter });
      record.outcome = 'dropped-no-progress';
      break;
    }
  }

  if (record.outcome === 'single-shot') {
    // Fell through maxRounds without setting a terminal outcome — accept plan as-is.
    record.outcome = 'max-rounds';
  }

  return { outcome: 'completed', plan, record };
}
