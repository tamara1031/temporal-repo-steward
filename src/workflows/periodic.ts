import {
  executeChild,
  workflowInfo,
  log,
  CancellationScope,
  ChildWorkflowCancellationType,
  ParentClosePolicy,
} from '@temporalio/workflow';
import { cheap, heavy, contextCodex, planCodex } from './proxies';
import { robustPRMergeWorkflow } from './pr-lifecycle';
import { refactorStepWorkflow } from './refactor-step';
import type { ContextArtifact, PlanOutput } from '../activities/refactor';
import { filesFromPorcelain, diffPorcelain } from './_internal/porcelain';
import { AdvisorBudget, type AdvisorAuditEntry } from './_internal/advisor';
import { renderReport, type StepRecord } from './_internal/refactor-report';
import { DEFAULT_PERIODIC_SPAWN_CAP, SpawnCounter } from './_internal/spawn-budget';
import {
  DEFAULT_STEP_LOOP_CONFIG,
  type CircuitBreaker,
} from './_internal/refactor-step-loop';

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
  const workdir = clone.workdir;
  const spawnCounter = new SpawnCounter(DEFAULT_PERIODIC_SPAWN_CAP);
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
    // Each step runs as its own child workflow (`refactorStepWorkflow`) so the
    // implement→Parliament loop is reusable from non-periodic orchestrators.
    // The child receives a slice of our remaining budgets; on return we apply
    // the deltas back to the parent's counters.
    const stepRecords: StepRecord[] = [];
    let circuitBroken: CircuitBreaker | undefined;

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

      const preStepStatus = await cheap.statusPorcelainActivity({ workdir });
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
      for (const [role, n] of Object.entries(childOutput.spawnCounts)) {
        spawnCounter.consume(role, n);
      }
      advisorBudget.addConsumed(childOutput.advisorConsumed);
      advisorAudits.push(...childOutput.advisorAudits);

      if (childOutput.kind === 'budget-halted') {
        break;
      }
      if (childOutput.kind === 'circuit-broken' && childOutput.record) {
        stepRecords.push(childOutput.record);
        circuitBroken = childOutput.circuitBroken;
        break;
      }
      // kind === 'completed'
      if (!childOutput.record) continue; // defensive: shouldn't happen for 'completed'
      if (childOutput.record.outcome === 'dropped-not-converged') {
        // Roll back only the files this step added on top of prior steps.
        // Using diffPorcelain against the pre-step snapshot avoids wiping
        // converged changes from earlier steps that share the same workdir.
        const cur = await cheap.statusPorcelainActivity({ workdir });
        const stepFiles = diffPorcelain(preStepStatus.entries, cur.entries);
        if (stepFiles.length > 0) {
          await cheap.restoreActivity({ workdir, paths: stepFiles });
        }
      }
      stepRecords.push(childOutput.record);
    }

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
      stepCap: MAX_STEPS,
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

