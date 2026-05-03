import {
  executeChild,
  workflowInfo,
  log,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
} from '@temporalio/workflow';
import {
  cheap,
  heavy,
  planCodex,
  implementCodex,
  reviewCodex,
} from './proxies';
import { robustPRMergeWorkflow } from './pr-lifecycle';
import type {
  PlanOutput,
  PlanStep,
  ReviewOutput,
  ReviewConcern,
} from '../activities/refactor';

export interface PeriodicRefactorInput {
  repoFullName: string;
  baseBranch?: string;
  refactorBrief?: string;
  /** When false, the child PR-lifecycle stops before merging. Defaults to true. */
  autoMerge?: boolean;
}

export interface PeriodicRefactorOutput {
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  skipped?: 'no-changes' | 'no-op-plan' | 'plan-failed';
}

/**
 * Hard cap on codex spawns per periodic run. Mirrors `easy-agent`'s
 * `max_consults` — the orchestrator (this workflow) counts and stops. Worst
 * case at 2 steps × 2 iter × (1 implementer + 2 reviewers) + 1 planner = 13.
 * Cap of 15 leaves a 2-spawn retry buffer.
 */
const MAX_SPAWNS = 15;
/** Pre-Parliament gate: skip reviewers when (insertions + deletions) AND files are below these. */
const TRIVIAL_LINE_THRESHOLD = 30;
const TRIVIAL_FILE_THRESHOLD = 3;
/** Hard cap on plan steps regardless of what the planner returns. */
const MAX_STEPS = 2;
/** Per-step iteration cap (iter 0..MAX_ITER-1). */
const MAX_ITER = 2;
/** Diff text size handed to each reviewer. */
const REVIEW_DIFF_BYTES = 8 * 1024;

const REVIEWER_CONCERNS: readonly ReviewConcern[] = ['correctness', 'quality'];

/**
 * Per-step ledger entry retained for the final PR body. Workflow state stays
 * small — we keep only what the report needs, not raw codex output.
 */
interface StepRecord {
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

interface ParliamentSummary {
  iter: number;
  /** Empty when Parliament was skipped (trivial diff). */
  reviews: { concern: ReviewConcern; verdict: ReviewOutput['verdict']; bullets: string[] }[];
  skipped?: 'trivial-diff';
}

/**
 * periodicRefactorWorkflow — runs on a Temporal Schedule.
 *
 * Pipeline (one Temporal Activity per role — full visibility in the UI):
 *   clone → plan → for each step: implement → diff-stat (gate) → optional
 *   parliament (correctness ‖ quality) → drift-audit → aggregate → iter
 *   → commit-and-handoff to robustPRMergeWorkflow.
 */
export async function periodicRefactorWorkflow(
  input: PeriodicRefactorInput,
): Promise<PeriodicRefactorOutput> {
  const baseBranch = input.baseBranch ?? 'main';
  const info = workflowInfo();
  const branch = `agent/refactor/${info.workflowId}`;

  const clone = await heavy.cloneRepoActivity({
    repoFullName: input.repoFullName,
    branch,
    ref: baseBranch,
  });
  const workdir = clone.workdir;
  const spawnCounter = new SpawnCounter(MAX_SPAWNS);

  try {
    // ── Phase 1. Plan ────────────────────────────────────────────────────
    let plan: PlanOutput;
    try {
      spawnCounter.consume('planner', 1);
      plan = await planCodex.planActivity({ workdir, brief: input.refactorBrief });
    } catch (err) {
      log.warn('planner failed; producing plan-failed report', { err: String(err) });
      return { skipped: 'plan-failed' };
    }

    if (plan.theme === 'no-op' || plan.steps.length === 0) {
      log.info('planner returned no-op; skipping refactor', { theme: plan.theme });
      return { skipped: 'no-op-plan' };
    }

    const plannedSteps = plan.steps.slice(0, MAX_STEPS);
    const droppedFromPlan = plan.steps.slice(MAX_STEPS);

    // ── Phase 2. Step loop ───────────────────────────────────────────────
    const stepRecords: StepRecord[] = [];
    let circuitBroken: { step: PlanStep; concern: ReviewConcern; bullets: string[] } | undefined;

    stepLoop: for (const step of plannedSteps) {
      const record: StepRecord = {
        step,
        outcome: 'dropped-not-converged',
        iters: 0,
        implementReports: [],
        parliamentSummary: [],
        driftReverts: [],
      };
      const accumulatedFeedback: string[] = [];
      let lastDiffSnapshot: { entries: string[] } | undefined;

      for (let iter = 0; iter < MAX_ITER; iter++) {
        record.iters = iter + 1;

        // 1. Implement
        if (!spawnCounter.canConsume(1)) {
          log.warn('spawn budget would be exceeded by implementer; halting step', {
            step: step.title,
          });
          break stepLoop;
        }
        spawnCounter.consume('implementer', 1);
        const implResult = await implementCodex.implementActivity({
          workdir,
          step,
          priorFeedback: accumulatedFeedback,
        });
        record.implementReports.push(implResult.report);

        // 2. Diff snapshot — drift baseline + no-progress check
        const postImplStatus = await cheap.statusPorcelainActivity({ workdir });
        if (
          iter > 0 &&
          lastDiffSnapshot &&
          arraysEqual(lastDiffSnapshot.entries, postImplStatus.entries)
        ) {
          log.info('no progress between iterations; rolling back this step', {
            step: step.title,
          });
          await cheap.restoreActivity({ workdir, paths: filesFromPorcelain(postImplStatus.entries) });
          record.outcome = 'dropped-no-progress';
          continue stepLoop;
        }
        lastDiffSnapshot = postImplStatus;

        // 3. Pre-Parliament Gate (trivial diff → skip Parliament)
        const stat = await cheap.diffStatActivity({ workdir });
        const isTrivial =
          stat.insertions + stat.deletions < TRIVIAL_LINE_THRESHOLD &&
          stat.filesChanged < TRIVIAL_FILE_THRESHOLD;

        if (isTrivial) {
          record.parliamentSummary.push({
            iter,
            reviews: [],
            skipped: 'trivial-diff',
          });
          record.outcome = 'parliament-skipped';
          continue stepLoop;
        }

        // 4. Parliament — parallel correctness + quality reviewers
        const remainingBudget = spawnCounter.remaining();
        if (remainingBudget < REVIEWER_CONCERNS.length) {
          log.warn('spawn budget too low for Parliament; halting step', {
            step: step.title,
            remainingBudget,
          });
          break stepLoop;
        }
        spawnCounter.consume('reviewer', REVIEWER_CONCERNS.length);
        const diffText = await cheap.diffTextActivity({ workdir, maxBytes: REVIEW_DIFF_BYTES });
        const reviews = await Promise.all(
          REVIEWER_CONCERNS.map((concern) =>
            reviewCodex.reviewActivity({
              workdir,
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
            concern: REVIEWER_CONCERNS[i],
            verdict: r.verdict,
            bullets: [...r.blocking_issues, ...r.suggestions].slice(0, 3),
          })),
        });

        const blocker = reviews.findIndex((r) => r.verdict === 'critical_block');
        if (blocker >= 0) {
          // Circuit Breaker: roll back EVERYTHING and bail.
          log.warn('critical_block from reviewer; rolling back entire pass', {
            step: step.title,
            concern: REVIEWER_CONCERNS[blocker],
          });
          await cheap.restoreActivity({ workdir });
          record.outcome = 'rolled-back-critical-block';
          circuitBroken = {
            step,
            concern: REVIEWER_CONCERNS[blocker],
            bullets: [...reviews[blocker].blocking_issues, ...reviews[blocker].suggestions].slice(0, 3),
          };
          stepRecords.push(record);
          break stepLoop;
        }

        if (reviews.every((r) => r.verdict === 'ok')) {
          record.outcome = 'converged';
          continue stepLoop;
        }

        // needs_revision → loop with feedback
        for (let i = 0; i < reviews.length; i++) {
          const r = reviews[i];
          const tag = REVIEWER_CONCERNS[i];
          for (const issue of r.blocking_issues) accumulatedFeedback.push(`[${tag}] ${issue}`);
          for (const sugg of r.suggestions.slice(0, 2)) accumulatedFeedback.push(`[${tag}] ${sugg}`);
        }
      } // end iterLoop

      if (record.outcome === 'dropped-not-converged') {
        // Roll back the failed step before moving on.
        const cur = await cheap.statusPorcelainActivity({ workdir });
        const stepFiles = filesFromPorcelain(cur.entries);
        if (stepFiles.length > 0) {
          await cheap.restoreActivity({ workdir, paths: stepFiles });
        }
      }
      stepRecords.push(record);
    } // end stepLoop

    // ── Phase 3. Handoff ─────────────────────────────────────────────────
    const finalStatus = await cheap.statusPorcelainActivity({ workdir });
    if (finalStatus.entries.length === 0) {
      log.info('no working-tree changes after refactor pass; skipping PR');
      return { skipped: 'no-changes' };
    }

    const prBody = renderReport({
      plan,
      droppedFromPlan,
      stepRecords,
      circuitBroken,
      spawnSummary: spawnCounter.summary(),
      branch,
    });

    await heavy.commitAllActivity({
      workdir,
      message: `refactor(auto): ${branch}`,
    });

    const prResult = await executeChild(robustPRMergeWorkflow, {
      args: [
        {
          repoFullName: input.repoFullName,
          workdir,
          branch,
          baseBranch,
          prTitle: `refactor(auto): ${plan.theme}`.slice(0, 70),
          prBody,
          autoMerge: input.autoMerge,
        },
      ],
      workflowId: `pr-lifecycle-${branch}`,
      parentClosePolicy: ParentClosePolicy.TERMINATE,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });

    return { prUrl: prResult.prUrl, prNumber: prResult.prNumber, merged: prResult.merged };
  } finally {
    await cheap.cleanupWorkspaceActivity({ workdir }).catch(() => undefined);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers — pure, deterministic, safe inside a workflow.
// ──────────────────────────────────────────────────────────────────────────

class SpawnCounter {
  private readonly counts: Record<string, number> = {};
  private total = 0;
  constructor(private readonly cap: number) {}
  canConsume(n: number): boolean {
    return this.total + n <= this.cap;
  }
  consume(role: string, n: number): void {
    this.counts[role] = (this.counts[role] ?? 0) + n;
    this.total += n;
  }
  remaining(): number {
    return Math.max(0, this.cap - this.total);
  }
  summary(): { total: number; cap: number; perRole: Record<string, number> } {
    return { total: this.total, cap: this.cap, perRole: { ...this.counts } };
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Files mentioned in `git status --porcelain` lines (after the 2-char status
 * prefix, ignoring the optional " -> " in renames).
 */
function filesFromPorcelain(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const path = e.slice(3);
    if (!path) continue;
    const rename = path.split(' -> ');
    out.push(rename[rename.length - 1]);
  }
  return out;
}

/**
 * Porcelain entries present in `after` but not in `before` — the workflow
 * uses this to revert reviewer drift. Comparing full porcelain lines (status
 * flag + path) catches both new files AND status-flag changes on existing
 * files (e.g. ` M` → `MM` when a reviewer edited an already-modified file).
 */
function diffPorcelain(before: readonly string[], after: readonly string[]): string[] {
  const beforeSet = new Set(before);
  const drifted: string[] = [];
  for (const e of after) {
    if (!beforeSet.has(e)) {
      const path = filesFromPorcelain([e])[0];
      if (path) drifted.push(path);
    }
  }
  return drifted;
}

interface ReportInput {
  plan: PlanOutput;
  droppedFromPlan: PlanStep[];
  stepRecords: StepRecord[];
  circuitBroken?: { step: PlanStep; concern: ReviewConcern; bullets: string[] };
  spawnSummary: { total: number; cap: number; perRole: Record<string, number> };
  branch: string;
}

function renderReport(r: ReportInput): string {
  const lines: string[] = [];
  lines.push('## Theme and intent');
  lines.push(`**${r.plan.theme}** — ${r.plan.rationale}`);
  lines.push('');
  if (r.circuitBroken) {
    lines.push('## ⛔ Circuit breaker fired');
    lines.push(
      `Reviewer **${r.circuitBroken.concern}** issued \`critical_block\` on step "${r.circuitBroken.step.title}". Working tree restored.`,
    );
    for (const b of r.circuitBroken.bullets) lines.push(`- ${b}`);
    lines.push('');
  }
  lines.push('## Step outcomes');
  for (const rec of r.stepRecords) {
    lines.push(`### Step: ${rec.step.title} — ${rec.outcome} (${rec.iters} iter)`);
    lines.push(rec.step.description);
    lines.push('');
    if (rec.implementReports.length > 0) {
      lines.push('**Implementer report (final iter):**');
      lines.push('');
      lines.push(rec.implementReports[rec.implementReports.length - 1]);
      lines.push('');
    }
    if (rec.parliamentSummary.length > 0) {
      lines.push('**Parliament:**');
      for (const ps of rec.parliamentSummary) {
        if (ps.skipped) {
          lines.push(`- iter ${ps.iter}: skipped (${ps.skipped})`);
          continue;
        }
        for (const rv of ps.reviews) {
          const tag = `[${rv.concern}: ${rv.verdict}]`;
          if (rv.bullets.length === 0) {
            lines.push(`- iter ${ps.iter} ${tag} (no findings)`);
          } else {
            lines.push(`- iter ${ps.iter} ${tag}`);
            for (const b of rv.bullets) lines.push(`  - ${b}`);
          }
        }
      }
      lines.push('');
    }
    if (rec.driftReverts.length > 0) {
      lines.push('**Reviewer drift reverted:**');
      for (const f of rec.driftReverts) lines.push(`- ${f}`);
      lines.push('');
    }
  }
  if (r.droppedFromPlan.length > 0) {
    lines.push('## ⚠️ Dropped by step cap');
    lines.push(`Planner returned ${r.droppedFromPlan.length + r.stepRecords.length} steps; cap is ${MAX_STEPS}. Dropped:`);
    for (const s of r.droppedFromPlan) lines.push(`- ${s.title}`);
    lines.push('');
  }
  lines.push('## Spawn budget');
  lines.push(`Used **${r.spawnSummary.total} / ${r.spawnSummary.cap}** codex calls.`);
  for (const [role, n] of Object.entries(r.spawnSummary.perRole)) {
    lines.push(`- ${role}: ${n}`);
  }
  lines.push('');
  lines.push(`*Branch: \`${r.branch}\`. Generated by periodicRefactorWorkflow.*`);
  return lines.join('\n');
}
