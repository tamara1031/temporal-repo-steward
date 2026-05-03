import {
  executeChild,
  workflowInfo,
  log,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
} from '@temporalio/workflow';
import {
  cheap,
  heavy,
  contextCodex,
  planCodex,
  implementCodex,
  reviewCodex,
} from './proxies';
import { robustPRMergeWorkflow } from './pr-lifecycle';
import type {
  ContextArtifact,
  PlanOutput,
  PlanStep,
  ReviewOutput,
  ReviewConcern,
} from '../activities/refactor';
import { arraysEqual, diffPorcelain, filesFromPorcelain } from './_internal/porcelain';
import {
  AdvisorBudget,
  consultAdvisor,
  type AdvisorAuditEntry,
} from './_internal/advisor';

export interface PeriodicRefactorInput {
  repoFullName: string;
  baseBranch?: string;
  refactorBrief?: string;
  /** When false, the child PR-lifecycle stops before merging. Defaults to true. */
  autoMerge?: boolean;
  /**
   * Hard cap on advisor (top-model) consultations within this workflow run.
   * Defaults to 1: critical_block from a reviewer is the only place we consult.
   * Set to 0 to disable advisor escalation entirely.
   */
  maxAdvisorConsults?: number;
}

export interface PeriodicRefactorOutput {
  prUrl?: string;
  prNumber?: number;
  merged?: boolean;
  /**
   * Forwarded from the child PR-lifecycle workflow when one ran. Lets the
   * operator distinguish "merge actually landed" from "merge queued" or
   * "merge superseded by an external close/merge".
   */
  prOutcome?:
    | 'merged'
    | 'merge-queued'
    | 'auto-merge-disabled'
    | 'closed-externally'
    | 'merged-externally';
  /**
   * Combined advisor audit trail (this workflow + child). The PR body
   * already lists the periodic-side consults; the child's are appended here
   * because they happen *after* PR body rendering.
   */
  advisorAudits?: AdvisorAuditEntry[];
  skipped?: 'no-changes' | 'no-op-plan' | 'plan-failed';
}

/**
 * Hard cap on codex spawns per periodic run. Mirrors `easy-agent`'s
 * `max_consults` — the orchestrator (this workflow) counts and stops. Worst
 * case is now 1 context-extractor + 1 planner + 2 steps × 2 iter ×
 * (1 implementer + 2 reviewers) = 14. Cap of 16 leaves a 2-spawn retry buffer.
 */
const MAX_SPAWNS = 16;
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
  const branch = `agent/refactor/${info.workflowId}`.replace(/:/g, '-');

  const clone = await heavy.cloneRepoActivity({
    repoFullName: input.repoFullName,
    branch,
    ref: baseBranch,
  });
  const workdir = clone.workdir;
  const spawnCounter = new SpawnCounter(MAX_SPAWNS);
  const advisorBudget = new AdvisorBudget(input.maxAdvisorConsults ?? 1);
  const advisorAudits: AdvisorAuditEntry[] = [];

  try {
    // ── Phase 0. Context Artifact ────────────────────────────────────────
    // One codex call distills a small repo summary that gets folded into the
    // *static* (cacheable) prefix of every downstream role prompt. This is
    // the prompt-cache hit lever — plan / implement / review all share the
    // same prefix bytes within a workflow run.
    const generatedAt = new Date(workflowInfo().startTime).toISOString();
    spawnCounter.consume('context', 1);
    const contextArtifact: ContextArtifact = await contextCodex.extractContextArtifactActivity({
      workdir,
      generatedAt,
    });

    // ── Phase 1. Plan ────────────────────────────────────────────────────
    let plan: PlanOutput;
    try {
      spawnCounter.consume('planner', 1);
      plan = await planCodex.planActivity({
        workdir,
        contextArtifact,
        brief: input.refactorBrief,
      });
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
          contextArtifact,
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
            concern: REVIEWER_CONCERNS[i],
            verdict: r.verdict,
            bullets: [...r.blocking_issues, ...r.suggestions].slice(0, 3),
          })),
        });

        const blocker = reviews.findIndex((r) => r.verdict === 'critical_block');
        if (blocker >= 0) {
          const blockerConcern = REVIEWER_CONCERNS[blocker];
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
              const tag = REVIEWER_CONCERNS[i];
              for (const issue of r.blocking_issues) accumulatedFeedback.push(`[${tag}] ${issue}`);
              for (const sugg of r.suggestions.slice(0, 2)) accumulatedFeedback.push(`[${tag}] ${sugg}`);
            }
            continue; // re-enter iter loop with the appended feedback
          }

          // Circuit Breaker: roll back EVERYTHING and bail.
          log.warn('critical_block from reviewer; rolling back entire pass', {
            step: step.title,
            concern: blockerConcern,
          });
          await cheap.restoreActivity({ workdir });
          record.outcome = 'rolled-back-critical-block';
          circuitBroken = {
            step,
            concern: blockerConcern,
            bullets: blockerBullets,
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
      advisorAudits,
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
      // ABANDON lets the child PR-merge complete autonomously even if the
      // periodic schedule is cancelled or the parent dies between "PR opened"
      // and "PR merged". The child has its own `maxFixIterations` cap so it
      // can't run forever.
      parentClosePolicy: ParentClosePolicy.ABANDON,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    });

    return {
      prUrl: prResult.prUrl,
      prNumber: prResult.prNumber,
      merged: prResult.merged,
      prOutcome: prResult.outcome,
      advisorAudits: [...advisorAudits, ...(prResult.advisorAudits ?? [])],
    };
  } finally {
    // Cleanup must run even when the workflow is cancelled — otherwise the
    // cancellation propagates to the cleanup activity and `workdir` leaks.
    // Errors are logged rather than swallowed so a chronically-failing cleanup
    // (disk full, permission issue) is observable.
    await CancellationScope.nonCancellable(async () => {
      try {
        await cheap.cleanupWorkspaceActivity({ workdir });
      } catch (err) {
        log.warn('cleanupWorkspaceActivity failed', { workdir, err: String(err) });
      }
    });
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

interface ReportInput {
  plan: PlanOutput;
  droppedFromPlan: PlanStep[];
  stepRecords: StepRecord[];
  circuitBroken?: { step: PlanStep; concern: ReviewConcern; bullets: string[] };
  spawnSummary: { total: number; cap: number; perRole: Record<string, number> };
  branch: string;
  advisorAudits: AdvisorAuditEntry[];
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
  if (r.advisorAudits.length > 0) {
    lines.push('## Advisor consults');
    lines.push(
      'The advisor (top-tier model) was consulted at the following decision gates. ' +
        'Verdicts are advisory; the rollback / continue defaults still applied unless ' +
        'the workflow comment notes otherwise.',
    );
    lines.push('');
    for (const a of r.advisorAudits) {
      lines.push(`### Gate: \`${a.gate}\``);
      lines.push(`> ${a.situation}`);
      if (a.reply) {
        lines.push(`- **Verdict**: \`${a.reply.verdict}\``);
        if (a.reply.rationale) lines.push(`- **Rationale**: ${a.reply.rationale}`);
        if (a.reply.suggestedAction) lines.push(`- **Suggested action**: ${a.reply.suggestedAction}`);
      } else if (a.error) {
        lines.push(`- (advisor call failed: ${a.error.slice(0, 200)})`);
      } else {
        lines.push('- (advisor budget exhausted; default path taken)');
      }
      lines.push('');
    }
  }
  lines.push(`*Branch: \`${r.branch}\`. Generated by periodicRefactorWorkflow.*`);
  return lines.join('\n');
}
