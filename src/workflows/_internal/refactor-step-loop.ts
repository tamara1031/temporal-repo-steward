/**
 * Per-step implement→Parliament loop, lifted out of `periodicRefactorWorkflow`.
 *
 * The orchestrator was a single 200-line `for (step of plan)` body with two
 * labeled `break stepLoop` exits and two labeled `continue stepLoop` exits.
 * This module replaces the labels with an explicit return value:
 *
 *   - `{ kind: 'completed', record }`        — proceed to the next step
 *   - `{ kind: 'budget-halted' }`            — break out of the step loop, no record
 *   - `{ kind: 'circuit-broken', record, circuitBroken }` — break out and
 *     remember the blocker that caused the rollback
 *
 * The helper mutates `advisorAudits` (the same convention as
 * `pr-lifecycle.ts` helpers): the caller owns the list, this code appends.
 *
 * Determinism: only Activity proxies, `log`, and pure helpers are used —
 * safe to call from any workflow file.
 *
 * ## Snapshot / rollback invariant
 *
 * At the start of every step, `snapshotWorkdirActivity` commits any
 * accumulated prior-step changes as a temporary checkpoint commit. This makes
 * full-workdir restores safe: `restoreActivity({ workdir })` only undoes the
 * current step (the snapshot is HEAD), and `popWorkdirSnapshotActivity`
 * then un-commits the checkpoint to return prior-step work to the working
 * tree as unstaged modifications. Every exit path calls either
 * `restoreAndPop` (rollback) or `keepAndPop` (convergence) exactly once.
 */

import { log } from '@temporalio/workflow';
import { cheap, implementCodex, reviewCodex } from '../proxies';
import type {
  ContextArtifact,
  PlanStep,
  ReviewConcern,
} from '../../activities/refactor';
import { arraysEqual, diffPorcelain } from './porcelain';
import { AdvisorBudget, consultAdvisor, type AdvisorAuditEntry } from './advisor';
import type { StepRecord } from './refactor-report';
import type { SpawnCounter } from './spawn-budget';

export interface CircuitBreaker {
  step: PlanStep;
  concern: ReviewConcern;
  bullets: string[];
}

export type StepLoopResult =
  | { kind: 'completed'; record: StepRecord }
  | { kind: 'budget-halted' }
  | { kind: 'circuit-broken'; record: StepRecord; circuitBroken: CircuitBreaker };

export interface StepLoopConfig {
  /** Per-step iteration cap (iter 0..maxIter-1). */
  maxIter: number;
  /** Pre-Parliament gate: skip Parliament when (insertions + deletions) is below this. */
  trivialLineThreshold: number;
  /** Pre-Parliament gate: skip Parliament when filesChanged is below this. */
  trivialFileThreshold: number;
  /** Diff text size handed to each reviewer. */
  reviewDiffBytes: number;
  /** Reviewer roles to dispatch in parallel for non-trivial diffs. */
  reviewerConcerns: readonly ReviewConcern[];
}

/**
 * Canonical defaults for orchestrators that drive `refactorStepWorkflow`.
 * Lives next to `StepLoopConfig` so the constant and the type stays in sync.
 * Callers either pass this directly as `RefactorStepInput.config` or spread
 * it (`{ ...DEFAULT_STEP_LOOP_CONFIG, maxIter: 1 }`) for one-off overrides.
 */
export const DEFAULT_STEP_LOOP_CONFIG: StepLoopConfig = {
  maxIter: 2,
  trivialLineThreshold: 30,
  trivialFileThreshold: 3,
  reviewDiffBytes: 8 * 1024,
  reviewerConcerns: ['correctness', 'quality'],
};

export interface RunStepInput {
  step: PlanStep;
  workdir: string;
  contextArtifact: ContextArtifact;
  spawnCounter: SpawnCounter;
  advisorBudget: AdvisorBudget;
  /** Mutated in-place: `runRefactorStep` appends every advisor consult. */
  advisorAudits: AdvisorAuditEntry[];
  config: StepLoopConfig;
}

/**
 * Run one plan step end-to-end (all iterations, with circuit-breaker /
 * budget-halt handling). Caller decides whether to continue with the next
 * step based on the returned `kind`.
 */
export async function runRefactorStep(input: RunStepInput): Promise<StepLoopResult> {
  const {
    step,
    workdir,
    contextArtifact,
    spawnCounter,
    advisorBudget,
    advisorAudits,
    config,
  } = input;
  const { maxIter, trivialLineThreshold, trivialFileThreshold, reviewDiffBytes, reviewerConcerns } =
    config;

  const record: StepRecord = {
    step,
    outcome: 'dropped-not-converged',
    iters: 0,
    implementReports: [],
    parliamentSummary: [],
    driftReverts: [],
  };
  const accumulatedFeedback: string[] = [];
  let lastDiffText: string | undefined;
  let lastPorcelainEntries: string[] | undefined;

  // Commit any accumulated prior-step changes as a checkpoint so that a full
  // restoreActivity({ workdir }) only undoes THIS step's work (HEAD = snapshot).
  // popSnap() then un-commits the checkpoint, restoring prior changes to the
  // working tree. Both helpers are called exactly once on every exit path.
  const snap = await cheap.snapshotWorkdirActivity({ workdir });

  const popSnap = async () => {
    if (snap.snapped) {
      await cheap.popWorkdirSnapshotActivity({ workdir });
    }
  };

  // Discard this step's changes and restore the prior-step state.
  const restoreAndPop = async () => {
    await cheap.restoreActivity({ workdir }); // resets working tree to HEAD (= snapshot)
    await popSnap(); // un-commits snapshot → prior changes back as unstaged
  };

  for (let iter = 0; iter < maxIter; iter++) {
    record.iters = iter + 1;

    // 1. Implement
    if (!spawnCounter.canConsume(1)) {
      log.warn('spawn budget would be exceeded by implementer; halting step', {
        step: step.title,
      });
      // No implementer ran this iter — keep any prior-iter implementer changes.
      await popSnap();
      return { kind: 'budget-halted' };
    }
    spawnCounter.consume('implementer', 1);
    const implResult = await implementCodex.implementActivity({
      workdir,
      contextArtifact,
      step,
      priorFeedback: accumulatedFeedback,
    });
    // Overwrite rather than accumulate: the report renderer reads only the
    // final iter's report, so keeping every iteration's copy would waste
    // workflow state (up to 16 KiB × maxIter per step). Replacing preserves
    // the array shape so the renderer contract (`implementReports[length-1]`)
    // stays valid without changes.
    record.implementReports = [implResult.report];

    // 2. Diff snapshot — fetch status, diff text, and diff stat in parallel.
    //    All three are independent reads of the workdir at the same point in
    //    time; running them concurrently saves one activity round-trip per iter.
    //    - diffTextActivity: content diff for no-progress comparison + parliament
    //    - statusPorcelainActivity: file-set for drift detection + no-progress
    //    - diffStatActivity: line counts for the Pre-Parliament Gate
    const [postImplStatus, postImplDiff, stat] = await Promise.all([
      cheap.statusPorcelainActivity({ workdir }),
      cheap.diffTextActivity({ workdir, maxBytes: reviewDiffBytes }),
      cheap.diffStatActivity({ workdir }),
    ]);
    // No-progress detection: require BOTH the diff text AND the porcelain
    // file-set to be unchanged before calling it no-progress.
    // - diff text captures content changes to tracked files
    // - porcelain entries capture new untracked files (git diff omits them)
    // Either signal differing means the implementer made real progress.
    if (
      iter > 0 &&
      lastDiffText !== undefined &&
      lastPorcelainEntries !== undefined &&
      lastDiffText === postImplDiff.text &&
      arraysEqual(lastPorcelainEntries, postImplStatus.entries)
    ) {
      log.info('no progress between iterations; rolling back this step', {
        step: step.title,
      });
      await restoreAndPop();
      record.outcome = 'dropped-no-progress';
      return { kind: 'completed', record };
    }
    lastDiffText = postImplDiff.text;
    lastPorcelainEntries = postImplStatus.entries;

    // 3. Pre-Parliament Gate (trivial diff → skip Parliament)
    const isTrivial =
      stat.insertions + stat.deletions < trivialLineThreshold &&
      stat.filesChanged < trivialFileThreshold;

    if (isTrivial) {
      record.parliamentSummary.push({
        iter,
        reviews: [],
        skipped: 'trivial-diff',
      });
      record.outcome = 'parliament-skipped';
      await popSnap();
      return { kind: 'completed', record };
    }

    // 4. Parliament — parallel correctness + quality reviewers
    const remainingBudget = spawnCounter.remaining();
    if (remainingBudget < reviewerConcerns.length) {
      log.warn('spawn budget too low for Parliament; halting step', {
        step: step.title,
        remainingBudget,
      });
      // Implementer ran — keep its changes so they can go into the final PR.
      await popSnap();
      return { kind: 'budget-halted' };
    }
    spawnCounter.consume('reviewer', reviewerConcerns.length);
    const diffText = postImplDiff; // already fetched above
    const reviews = await Promise.all(
      reviewerConcerns.map((concern) =>
        reviewCodex.reviewActivity({
          workdir,
          contextArtifact,
          step,
          diff: diffText.text,
          concern,
        }),
      ),
    );

    // 5. Drift audit — revert any reviewer-introduced changes
    const postReviewStatus = await cheap.statusPorcelainActivity({ workdir });
    const driftedFiles = diffPorcelain(postImplStatus.entries, postReviewStatus.entries);
    if (driftedFiles.length > 0) {
      log.warn('reviewer drift detected; reverting', { files: driftedFiles });
      await cheap.restoreActivity({ workdir, paths: driftedFiles });
      record.driftReverts.push(...driftedFiles);
    }

    // 6. Aggregate
    record.parliamentSummary.push({
      iter,
      reviews: reviews.map((r, i) => ({
        concern: reviewerConcerns[i],
        verdict: r.verdict,
        bullets: [...r.blocking_issues, ...r.suggestions].slice(0, 3),
      })),
    });

    const blocker = reviews.findIndex((r) => r.verdict === 'critical_block');
    if (blocker >= 0) {
      const blockerConcern = reviewerConcerns[blocker];
      const blockerBullets = [
        ...reviews[blocker].blocking_issues,
        ...reviews[blocker].suggestions,
      ].slice(0, 3);

      // Optional advisor consult: critical_block is a hard rollback by
      // default, but a single reviewer can be over-cautious. Only `retry`
      // from the advisor downgrades to needs_revision (loop with feedback);
      // anything else (or no consult — budget exhausted, advisor failed)
      // keeps the rollback. Note: with the default budget=1, only the
      // first critical_block per workflow gets a consult.
      const { reply, audit } = await consultAdvisor(advisorBudget, 'critical-block', {
        workdir,
        situation: `Reviewer (${blockerConcern}) issued critical_block on step "${step.title}". Default action is full rollback.`,
        summary: [
          `Step: ${step.title}`,
          `Reviewer concern: ${blockerConcern}`,
          `Reviewer's top issues:`,
          ...blockerBullets.slice(0, 3).map((b) => `- ${b}`),
        ].join('\n'),
        options: [
          'retry — reviewer is over-cautious; downgrade to needs_revision and let the implementer try again',
          'abort — issue is genuinely critical; keep the rollback and surface to a human',
          'change-strategy — keep the rollback but record the suggested next direction',
        ],
      });
      advisorAudits.push(audit);
      if (reply?.verdict === 'retry') {
        log.info('advisor downgraded critical_block to needs_revision', {
          step: step.title,
          concern: blockerConcern,
        });
        for (const issue of reviews[blocker].blocking_issues) {
          accumulatedFeedback.push(`[${blockerConcern}] ${issue}`);
        }
        for (const sugg of reviews[blocker].suggestions.slice(0, 2)) {
          accumulatedFeedback.push(`[${blockerConcern}] ${sugg}`);
        }
        // Other reviewers' feedback still applies.
        for (let i = 0; i < reviews.length; i++) {
          if (i === blocker) continue;
          const r = reviews[i];
          const tag = reviewerConcerns[i];
          for (const issue of r.blocking_issues) accumulatedFeedback.push(`[${tag}] ${issue}`);
          for (const sugg of r.suggestions.slice(0, 2)) accumulatedFeedback.push(`[${tag}] ${sugg}`);
        }
        continue; // re-enter iter loop with the appended feedback
      }

      // Circuit Breaker: roll back this step's changes only, then bail.
      log.warn('critical_block from reviewer; rolling back this step', {
        step: step.title,
        concern: blockerConcern,
      });
      await restoreAndPop();
      record.outcome = 'rolled-back-critical-block';
      return {
        kind: 'circuit-broken',
        record,
        circuitBroken: { step, concern: blockerConcern, bullets: blockerBullets },
      };
    }

    if (reviews.every((r) => r.verdict === 'ok')) {
      record.outcome = 'converged';
      await popSnap();
      return { kind: 'completed', record };
    }

    // needs_revision → loop with feedback
    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      const tag = reviewerConcerns[i];
      for (const issue of r.blocking_issues) accumulatedFeedback.push(`[${tag}] ${issue}`);
      for (const sugg of r.suggestions.slice(0, 2)) accumulatedFeedback.push(`[${tag}] ${sugg}`);
    }
  } // end iterLoop

  // Fell through maxIter without convergence — roll back this step's changes.
  await restoreAndPop();
  return { kind: 'completed', record }; // record.outcome = 'dropped-not-converged'
}
