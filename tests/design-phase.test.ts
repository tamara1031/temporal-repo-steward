/**
 * Contract tests for `designPhaseWorkflow`. The parent
 * (`periodicRefactorWorkflow`) and future orchestrators rely on a stable
 * shape for the child's return:
 *
 *   - `outcome` discriminates between proceeding and skipping.
 *   - `plan` carries the (possibly parliament-refined) plan.
 *   - `spawnCounts` let the parent reconcile budgets.
 *   - `designRecord` feeds the PR body report renderer.
 *
 * These tests pin those guarantees directly at the workflow boundary so a
 * change to the inner loop (`runDesignPhase`) cannot silently alter the
 * cross-workflow contract.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { ERR_PLANNER_OUTPUT_INVALID } from '../src/errors';
import { randomUUID } from 'crypto';
import { designPhaseWorkflow } from '../src/workflows';
import {
  DEFAULT_DESIGN_PHASE_CONFIG,
  type DesignPhaseInput,
} from '../src/workflows/design-phase';
import { getWorkflowBundle, makeMockActivities } from './helpers';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

const baseContextArtifact = {
  overview: 'stub repo: Temporal-driven refactor pipeline (TypeScript)',
  conventions: ['activities are pure functions'],
  interfaces: ['Activity I/O is JSON-serializable'],
  generatedAt: '2026-05-03T00:00:00.000Z',
};

const baseInput: DesignPhaseInput = {
  workdir: '/tmp/agent-workspaces/mock',
  contextArtifact: baseContextArtifact,
  spawnBudget: 16,
  config: DEFAULT_DESIGN_PHASE_CONFIG,
};

async function runWorkflow(
  taskQueue: string,
  activities: ReturnType<typeof makeMockActivities>['activities'],
  input: DesignPhaseInput,
) {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await getWorkflowBundle(),
    activities,
  });
  return worker.runUntil(
    env.client.workflow.execute(designPhaseWorkflow, {
      taskQueue,
      workflowId: `design-phase-${randomUUID()}`,
      args: [input],
    }),
  );
}

describe('designPhaseWorkflow', () => {
  it('returns completed/converged when both plan reviewers approve on the first round', async () => {
    // Default helpers: planActivity returns a valid plan, reviewPlanActivity returns `ok`.
    const { activities, calls } = makeMockActivities();

    const result = await runWorkflow('design-phase-converged', activities, baseInput);

    expect(result.outcome).toBe('completed');
    expect(result.plan).toBeDefined();
    expect(result.plan?.theme).toBe('tighten module boundaries');
    expect(result.designRecord).toBeDefined();
    expect(result.designRecord?.outcome).toBe('converged');
    expect(result.designRecord?.iters).toBe(1);
    expect(result.designRecord?.rounds).toHaveLength(1);

    // 1 planner + 2 plan-reviewers; no refiner (converged on round 0).
    expect(result.spawnCounts).toEqual({ planner: 1, 'plan-reviewer': 2 });

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('planActivity');
    expect(names.filter((n) => n === 'reviewPlanActivity').length).toBe(2);
    expect(names).not.toContain('refinePlanActivity');
  });

  it('returns completed/single-shot and skips parliament when maxRounds=0', async () => {
    const { activities, calls } = makeMockActivities();

    const result = await runWorkflow('design-phase-single-shot', activities, {
      ...baseInput,
      config: { ...DEFAULT_DESIGN_PHASE_CONFIG, maxRounds: 0 },
    });

    expect(result.outcome).toBe('completed');
    expect(result.plan).toBeDefined();
    expect(result.designRecord?.outcome).toBe('single-shot');
    expect(result.designRecord?.rounds).toHaveLength(0);

    // Only the planner ran.
    expect(result.spawnCounts).toEqual({ planner: 1 });

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('planActivity');
    expect(names).not.toContain('reviewPlanActivity');
    expect(names).not.toContain('refinePlanActivity');
  });

  it('returns no-op when the planner returns theme=no-op', async () => {
    const { activities, calls } = makeMockActivities({
      planActivity: async () => ({
        theme: 'no-op',
        rationale: 'repo is already optimal',
        steps: [],
      }),
    });

    const result = await runWorkflow('design-phase-noop', activities, baseInput);

    expect(result.outcome).toBe('no-op');
    expect(result.plan?.theme).toBe('no-op');
    // Parliament should not run for a no-op plan.
    expect(result.spawnCounts).toEqual({ planner: 1 });

    const names = calls.log.map((c) => c.name);
    expect(names).not.toContain('reviewPlanActivity');
  });

  it('returns plan-failed when the planner throws a non-retryable error', async () => {
    const { activities, calls } = makeMockActivities({
      planActivity: async () => {
        throw ApplicationFailure.nonRetryable(
          'planner did not return a parseable JSON object',
          ERR_PLANNER_OUTPUT_INVALID,
        );
      },
    });

    const result = await runWorkflow('design-phase-plan-failed', activities, baseInput);

    expect(result.outcome).toBe('plan-failed');
    expect(result.plan).toBeUndefined();
    expect(result.spawnCounts).toEqual({ planner: 1 });

    const names = calls.log.map((c) => c.name);
    expect(names).not.toContain('reviewPlanActivity');
  });

  it('returns budget-exhausted when spawnBudget=0', async () => {
    const { activities, calls } = makeMockActivities();

    const result = await runWorkflow('design-phase-budget', activities, {
      ...baseInput,
      spawnBudget: 0,
    });

    expect(result.outcome).toBe('budget-exhausted');
    expect(result.plan).toBeUndefined();
    expect(result.spawnCounts).toEqual({});

    const names = calls.log.map((c) => c.name);
    expect(names).not.toContain('planActivity');
    expect(names).not.toContain('reviewPlanActivity');
  });

  it('refines the plan and returns max-rounds after exhausting rounds', async () => {
    // Both reviewers always return needs_revision; refiner returns a genuinely
    // different plan each time so no-progress detection does not fire first.
    let refineCount = 0;
    const { activities, calls } = makeMockActivities({
      reviewPlanActivity: async () => ({
        verdict: 'needs_revision' as const,
        blocking_issues: ['step description is too vague'],
        suggestions: ['add concrete file paths'],
      }),
      refinePlanActivity: async () => {
        refineCount += 1;
        return {
          theme: 'tighten module boundaries',
          rationale: `reduces coupling (revision ${refineCount})`,
          steps: [
            {
              title: 'extract shared types',
              description: `move shared interfaces into a dedicated module (v${refineCount})`,
              critical_requirements: ['all existing unit tests still pass'],
            },
          ],
        };
      },
    });

    const result = await runWorkflow('design-phase-max-rounds', activities, {
      ...baseInput,
      config: { maxRounds: 1, reviewerConcerns: ['feasibility', 'scope'] },
    });

    expect(result.outcome).toBe('completed');
    expect(result.designRecord?.outcome).toBe('max-rounds');
    expect(result.designRecord?.iters).toBe(1);

    // 1 planner + 2 reviewers + 1 refiner (one round of review+refine).
    expect(result.spawnCounts).toEqual({ planner: 1, 'plan-reviewer': 2, 'plan-refiner': 1 });

    const names = calls.log.map((c) => c.name);
    expect(names.filter((n) => n === 'reviewPlanActivity').length).toBe(2);
    expect(names.filter((n) => n === 'refinePlanActivity').length).toBe(1);
  });

  it('returns dropped-no-progress when the refiner returns the same plan unchanged', async () => {
    const unchangedPlan = {
      theme: 'tighten module boundaries',
      rationale: 'reduces inter-module coupling',
      steps: [
        {
          title: 'extract shared types',
          description: 'move shared interfaces into a dedicated module',
          critical_requirements: ['all existing unit tests still pass'],
        },
      ],
    };
    const { activities } = makeMockActivities({
      reviewPlanActivity: async () => ({
        verdict: 'needs_revision' as const,
        blocking_issues: ['step is still vague'],
        suggestions: [],
      }),
      // Refiner returns the identical plan — no-progress detection should fire.
      refinePlanActivity: async () => unchangedPlan,
    });

    const result = await runWorkflow('design-phase-no-progress', activities, {
      ...baseInput,
      config: { maxRounds: 2, reviewerConcerns: ['feasibility', 'scope'] },
    });

    expect(result.outcome).toBe('completed');
    expect(result.designRecord?.outcome).toBe('dropped-no-progress');
    // Only one review round completed before no-progress was detected.
    expect(result.designRecord?.iters).toBe(1);

    // 1 planner + 2 reviewers + 1 refiner (no second review round; bailed after no-progress).
    expect(result.spawnCounts).toEqual({ planner: 1, 'plan-reviewer': 2, 'plan-refiner': 1 });
  });
});
