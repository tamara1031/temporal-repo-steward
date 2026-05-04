import {
  executeChild,
  workflowInfo,
  log,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
} from '@temporalio/workflow';
import { cheap, heavy, contextCodex } from './proxies';
import { robustPRMergeWorkflow } from './pr-lifecycle';
import type { PRMergeOutcome } from './pr-lifecycle';
import { refactorStepWorkflow } from './refactor-step';
import { designPhaseWorkflow, DEFAULT_DESIGN_PHASE_CONFIG } from './design-phase';
import type { ContextArtifact } from '../activities/refactor';
import { AdvisorBudget, type AdvisorAuditEntry } from './_internal/advisor';
import { renderReport, type StepRecord } from './_internal/refactor-report';
import { DEFAULT_PERIODIC_SPAWN_CAP, SpawnCounter } from './_internal/spawn-budget';
import {
  DEFAULT_STEP_LOOP_CONFIG,
  type CircuitBreaker,
} from './_internal/refactor-step-loop';
import { recoverWorkdir } from './_internal/workdir-recovery';

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
  prOutcome?: PRMergeOutcome;
  /**
   * Combined advisor audit trail (this workflow + child). The PR body
   * already lists the periodic-side consults; the child's are appended here
   * because they happen *after* PR body rendering.
   */
  advisorAudits?: AdvisorAuditEntry[];
  skipped?: 'no-changes' | 'no-op-plan' | 'plan-failed';
}

/** Hard cap on plan steps regardless of what the planner returns. */
const MAX_STEPS = 2;

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
  let workdir = clone.workdir;

  // Push the branch to GitHub immediately so subsequent ensureWorkdirActivity
  // calls can re-clone it on pod replacement. The narrow window between this
  // clone and the push is an accepted trade-off: a pod death in those few
  // seconds requires a clean retry on the next schedule tick.
  await heavy.pushBranchActivity({ workdir, branch, setUpstream: true });
  const spawnCounter = new SpawnCounter(DEFAULT_PERIODIC_SPAWN_CAP);
  const advisorBudget = new AdvisorBudget(input.maxAdvisorConsults ?? 1);
  const advisorAudits: AdvisorAuditEntry[] = [];

  try {
    // ── Phase 0. Context Artifact ────────────────────────────────────────
    // One codex call distills a small repo summary that gets folded into the
    // *static* (cacheable) prefix of every downstream role prompt. This is
    // the prompt-cache hit lever — plan / implement / review all share the
    // same prefix bytes within a workflow run.

    // Recover workdir if the pod was replaced between pushBranchActivity and
    // here — the first activity boundary a pod restart could hit before any
    // codex work begins.
    workdir = await recoverWorkdir(heavy.ensureWorkdirActivity, {
      workdir,
      repoFullName: input.repoFullName,
      branch,
    });

    const generatedAt = new Date(workflowInfo().startTime).toISOString();
    spawnCounter.consume('context', 1);
    const contextArtifact: ContextArtifact = await contextCodex.extractContextArtifactActivity({
      workdir,
      generatedAt,
    });

    // ── Phase 1. Design ──────────────────────────────────────────────────
    // Runs the planner + optional Design Parliament (plan review + refinement
    // rounds) as a child workflow. The child gets a capped budget slice; we
    // reconcile its spawn counts back onto our counter afterward.
    const designBudget = Math.min(8, spawnCounter.remaining());
    const designOutput = await executeChild(designPhaseWorkflow, {
      args: [
        {
          workdir,
          contextArtifact,
          brief: input.refactorBrief,
          spawnBudget: designBudget,
          config: DEFAULT_DESIGN_PHASE_CONFIG,
        },
      ],
      workflowId: `design-phase-${info.workflowId}`.replace(/:/g, '-'),
    });
    spawnCounter.reconcile(designOutput.spawnCounts);

    if (designOutput.outcome === 'plan-failed' || designOutput.outcome === 'budget-exhausted') {
      log.warn('design phase failed; skipping refactor', { outcome: designOutput.outcome });
      return { skipped: 'plan-failed' };
    }
    if (designOutput.outcome === 'no-op') {
      log.info('design phase returned no-op; skipping refactor');
      return { skipped: 'no-op-plan' };
    }

    const plan = designOutput.plan!;
    const plannedSteps = plan.steps.slice(0, MAX_STEPS);
    const droppedFromPlan = plan.steps.slice(MAX_STEPS);

    // Recover workdir if the pod was replaced during the (potentially long)
    // design phase. The branch is already on GitHub from the push above.
    workdir = await recoverWorkdir(heavy.ensureWorkdirActivity, {
      workdir,
      repoFullName: input.repoFullName,
      branch,
    });

    // ── Phase 2. Step loop ───────────────────────────────────────────────
    // Each step runs as its own child workflow (`refactorStepWorkflow`) so the
    // implement→Parliament loop is reusable from non-periodic orchestrators.
    // The child receives a slice of our remaining budgets; on return we apply
    // the deltas back to the parent's counters.
    const stepRecords: StepRecord[] = [];
    let circuitBroken: CircuitBreaker | undefined;
    // True once any step's changes have been pushed to GitHub. Used by the
    // no-changes gate below — inter-step commits leave the working tree clean
    // so statusPorcelainActivity alone cannot detect committed-but-not-merged work.
    let hasChanges = false;

    for (let stepIndex = 0; stepIndex < plannedSteps.length; stepIndex++) {
      const step = plannedSteps[stepIndex];
      // Budget exhausted before we even start the next step — record nothing
      // (matches the legacy in-process behavior of `break stepLoop` before
      // the implementer Activity ran).
      if (spawnCounter.remaining() === 0) {
        log.warn('parent spawn budget already exhausted; skipping remaining steps', {
          step: step.title,
        });
        break;
      }

      // Recover workdir if the pod was replaced since the last step completed.
      workdir = await recoverWorkdir(heavy.ensureWorkdirActivity, {
        workdir,
        repoFullName: input.repoFullName,
        branch,
      });

      const childOutput = await executeChild(refactorStepWorkflow, {
        args: [
          {
            step,
            workdir,
            contextArtifact,
            spawnBudget: spawnCounter.remaining(),
            advisorBudget: advisorBudget.remaining(),
            config: DEFAULT_STEP_LOOP_CONFIG,
          },
        ],
        workflowId: `refactor-step-${info.workflowId}-${stepIndex}`.replace(/:/g, '-'),
      });

      // Reconcile child's accounting with parent's budgets.
      spawnCounter.reconcile(childOutput.spawnCounts);
      advisorBudget.addConsumed(childOutput.advisorConsumed);
      advisorAudits.push(...childOutput.advisorAudits);

      // Push this step's work to GitHub before the next wait boundary so a
      // pod replacement between steps doesn't lose accumulated changes.
      // Only call for steps that kept their changes: converged or
      // parliament-skipped (popSnap path). Rolled-back and circuit-broken
      // steps call restoreAndPop(), which leaves the working tree clean.
      // budget-halted may carry partial implementer work if the budget ran
      // out after the implementer ran but before the reviewers could.
      const stepProducedChanges =
        childOutput.kind === 'budget-halted' ||
        (childOutput.kind === 'completed' &&
          (childOutput.record.outcome === 'converged' ||
            childOutput.record.outcome === 'parliament-skipped'));

      if (stepProducedChanges) {
        const stepPush = await heavy.commitAndPushActivity({
          workdir,
          branch,
          message: `refactor(auto): ${step.title}`,
        });
        if (stepPush.pushed) hasChanges = true;
      }

      if (childOutput.kind === 'budget-halted') {
        break;
      }
      if (childOutput.kind === 'circuit-broken') {
        stepRecords.push(childOutput.record);
        circuitBroken = childOutput.circuitBroken;
        break;
      }
      // kind === 'completed'
      // dropped-not-converged / dropped-no-progress / rolled-back-critical-block:
      // the child workflow already rolled back this step's changes via
      // restoreAndPop() before returning, so no workdir cleanup is needed here.
      stepRecords.push(childOutput.record);
    }

    // ── Phase 3. Handoff ─────────────────────────────────────────────────
    // Check both committed (hasChanges) and uncommitted working-tree changes.
    // Inter-step checkpoints leave the tree clean but their pushed commits
    // still count as real work, so we must not short-circuit on tree status alone.
    const finalStatus = await cheap.statusPorcelainActivity({ workdir });
    if (!hasChanges && finalStatus.entries.length === 0) {
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
      stepCap: MAX_STEPS,
      designRecord: designOutput.designRecord,
    });

    await heavy.commitAndPushActivity({
      workdir,
      branch,
      message: `refactor(auto): ${plan.theme}`,
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
