/**
 * Contract tests for `refactorStepWorkflow`. The parent
 * (`periodicRefactorWorkflow`) and any future orchestrators rely on a
 * stable shape for the child's return value:
 *
 *   - `kind` discriminates between continuing and stopping the outer loop.
 *   - `spawnCounts` / `advisorConsumed` let the parent reconcile budgets.
 *   - `record` carries the per-step ledger entry the report renderer needs.
 *
 * These tests pin those guarantees directly at the workflow boundary so a
 * change to the inner loop (`runRefactorStep`) cannot silently alter the
 * cross-workflow contract.
 *
 * Internal step-loop semantics (no-progress detection, drift audit, advisor
 * retry behaviour) are already exercised through `tests/periodic.test.ts`
 * — we deliberately don't re-test them here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { randomUUID } from 'crypto';
import { refactorStepWorkflow } from '../src/workflows';
import {
  DEFAULT_STEP_LOOP_CONFIG,
  type RefactorStepInput,
} from '../src/workflows/refactor-step';
import { runWorkflowWithMocks, type MockActivityOverrides } from './helpers';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

const baseInput: RefactorStepInput = {
  step: {
    title: 'extract shared types',
    description: 'move shared interfaces into a dedicated module',
    critical_requirements: ['all existing unit tests still pass'],
  },
  workdir: '/tmp/agent-workspaces/mock',
  contextArtifact: {
    overview: 'stub repo: Temporal-driven refactor pipeline (TypeScript)',
    conventions: ['activities are pure functions'],
    interfaces: ['Activity I/O is JSON-serializable'],
    generatedAt: '2026-05-03T00:00:00.000Z',
  },
  spawnBudget: 16,
  advisorBudget: 1,
  config: DEFAULT_STEP_LOOP_CONFIG,
};

async function runWorkflow(
  taskQueue: string,
  input: RefactorStepInput,
  activityOverrides?: MockActivityOverrides,
) {
  return runWorkflowWithMocks({
    env,
    taskQueue,
    workflow: refactorStepWorkflow,
    workflowId: `refactor-step-${randomUUID()}`,
    args: [input],
    activityOverrides,
  });
}

describe('refactorStepWorkflow', () => {
  it('completes with outcome=converged when both reviewers approve', async () => {
    // Default helpers mock both reviewers as `ok` and a non-trivial diff,
    // which is exactly the converged path.
    const { result, calls } = await runWorkflow('refactor-step-converged', baseInput);

    expect(result.kind).toBe('completed');
    expect(result.record).toBeDefined();
    expect(result.record?.outcome).toBe('converged');
    expect(result.circuitBroken).toBeUndefined();

    // 1 implementer + 2 reviewers (correctness, quality), no advisor consult.
    expect(result.spawnCounts).toEqual({ implementer: 1, reviewer: 2 });
    expect(result.advisorConsumed).toBe(0);
    expect(result.advisorAudits).toEqual([]);

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('implementActivity');
    expect(names.filter((n) => n === 'reviewActivity').length).toBe(2);
    expect(names).not.toContain('consultAdvisorActivity');
  });

  it('skips Parliament and returns parliament-skipped on a trivial diff', async () => {
    // Tip the diff under both thresholds so the Pre-Parliament Gate fires.
    const { result, calls } = await runWorkflow('refactor-step-trivial', baseInput, {
      diffStatActivity: async () => ({
        filesChanged: 1,
        insertions: 5,
        deletions: 2,
      }),
    });

    expect(result.kind).toBe('completed');
    expect(result.record?.outcome).toBe('parliament-skipped');

    // Only the implementer ran; no reviewers, no advisor.
    expect(result.spawnCounts).toEqual({ implementer: 1 });
    expect(result.advisorConsumed).toBe(0);

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('implementActivity');
    expect(names).not.toContain('reviewActivity');
    expect(names).not.toContain('consultAdvisorActivity');
  });

  it('returns kind=circuit-broken when a reviewer critical_blocks and advisor budget is 0', async () => {
    let restoreCalledWithoutPaths = false;
    const { result, calls } = await runWorkflow(
      'refactor-step-cb',
      {
        ...baseInput,
        // Advisor budget = 0 means consultAdvisor() returns reply: undefined,
        // so the workflow falls back to the default rollback.
        advisorBudget: 0,
      },
      {
        reviewActivity: async (input: any) => {
          if (input.concern === 'correctness') {
            return {
              verdict: 'critical_block' as const,
              blocking_issues: ['credential leak in src/foo.ts'],
              suggestions: ['rotate the leaked token'],
            };
          }
          return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
        },
        restoreActivity: async (input: any) => {
          if (!input?.paths) restoreCalledWithoutPaths = true;
          return undefined;
        },
      },
    );

    expect(result.kind).toBe('circuit-broken');
    expect(result.record).toBeDefined();
    expect(result.record?.outcome).toBe('rolled-back-critical-block');
    expect(result.circuitBroken).toBeDefined();
    expect(result.circuitBroken?.concern).toBe('correctness');
    expect(result.circuitBroken?.bullets).toContain('credential leak in src/foo.ts');

    // Reviewer ran, advisor never consulted (budget 0).
    expect(result.advisorConsumed).toBe(0);
    expect(restoreCalledWithoutPaths).toBe(true);

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('reviewActivity');
    expect(names).not.toContain('consultAdvisorActivity');
    expect(names).toContain('restoreActivity');
  });

  it('returns kind=budget-halted without running activities when spawnBudget is 0', async () => {
    const { result, calls } = await runWorkflow('refactor-step-budget', {
      ...baseInput,
      spawnBudget: 0,
    });

    expect(result.kind).toBe('budget-halted');
    // budget-halted carries no record (caller drops the partial step).
    expect(result.record).toBeUndefined();
    expect(result.circuitBroken).toBeUndefined();

    expect(result.spawnCounts).toEqual({});
    expect(result.advisorConsumed).toBe(0);

    const names = calls.log.map((c) => c.name);
    expect(names).not.toContain('implementActivity');
    expect(names).not.toContain('reviewActivity');
  });
});
