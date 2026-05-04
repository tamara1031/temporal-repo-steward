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
import type { RestoreInput } from '../src/activities/git';
import type { ReviewInput } from '../src/activities/refactor';
import {
  DEFAULT_STEP_LOOP_CONFIG,
  type RefactorStepInput,
} from '../src/workflows/refactor-step';
import { runWorkflowWithMocks, type ActivityCalls, type MockActivityOverrides } from './helpers';

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

function popCalls(calls: { log: Array<{ name: string; args: unknown[] }> }) {
  return calls.log.filter((c) => c.name === 'popWorkdirSnapshotActivity');
}

type ActivityCall = ActivityCalls['log'][number];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function readRestoreInput(call: ActivityCall): RestoreInput {
  const input = call.args[0];
  if (typeof input !== 'object' || input === null) {
    throw new Error('restoreActivity input must be an object');
  }
  const fields = input as Record<string, unknown>;
  if (typeof fields.workdir !== 'string') {
    throw new Error('restoreActivity input must include workdir');
  }
  if (fields.paths !== undefined && !isStringArray(fields.paths)) {
    throw new Error('restoreActivity paths must be a string array when present');
  }
  if (fields.paths === undefined) {
    return { workdir: fields.workdir };
  }
  return { workdir: fields.workdir, paths: fields.paths };
}

function fullRestoreCalls(calls: ActivityCalls) {
  return calls.log.filter((c) => {
    if (c.name !== 'restoreActivity') return false;
    return readRestoreInput(c).paths === undefined;
  });
}

function pathRestoreCalls(calls: ActivityCalls) {
  return calls.log.filter((c) => {
    if (c.name !== 'restoreActivity') return false;
    return readRestoreInput(c).paths !== undefined;
  });
}

describe('refactorStepWorkflow', () => {
  it('completes with outcome=converged when both reviewers approve', async () => {
    // Default helpers mock both reviewers as `ok` and a non-trivial diff,
    // which is exactly the converged path.
    const { result, calls } = await runWorkflow('refactor-step-converged', baseInput);

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error(`unexpected kind: ${result.kind}`);
    expect(result.record.outcome).toBe('converged');
    expect(result).not.toHaveProperty('circuitBroken');

    // 1 implementer + 2 reviewers (correctness, quality), no advisor consult.
    expect(result.spawnCounts).toEqual({ implementer: 1, reviewer: 2 });
    expect(result.advisorConsumed).toBe(0);
    expect(result.advisorAudits).toEqual([]);

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('implementActivity');
    expect(names.filter((n) => n === 'reviewActivity').length).toBe(2);
    expect(names).not.toContain('consultAdvisorActivity');
  });

  it('pops a snapped snapshot exactly once on keep exit paths', async () => {
    const snapshotOverride: MockActivityOverrides = {
      snapshotWorkdirActivity: async () => ({ snapped: true }),
    };
    const cases: Array<{
      taskQueue: string;
      input: RefactorStepInput;
      overrides?: MockActivityOverrides;
    }> = [
      {
        taskQueue: 'refactor-step-snapshot-keep-converged',
        input: baseInput,
      },
      {
        taskQueue: 'refactor-step-snapshot-keep-trivial',
        input: baseInput,
        overrides: {
          diffStatActivity: async () => ({
            filesChanged: 1,
            insertions: 5,
            deletions: 2,
          }),
        },
      },
      {
        taskQueue: 'refactor-step-snapshot-keep-implement-budget',
        input: {
          ...baseInput,
          spawnBudget: 0,
        },
      },
      {
        taskQueue: 'refactor-step-snapshot-keep-review-budget',
        input: {
          ...baseInput,
          spawnBudget: 2,
        },
      },
    ];

    for (const testCase of cases) {
      const { calls } = await runWorkflow(testCase.taskQueue, testCase.input, {
        ...snapshotOverride,
        ...testCase.overrides,
      });

      expect(popCalls(calls).length).toBe(1);
      expect(fullRestoreCalls(calls).length).toBe(0);
    }
  });

  it('restores without paths before popping a snapped snapshot on rollback exit paths', async () => {
    const rollbackCases: Array<{
      taskQueue: string;
      input: RefactorStepInput;
      overrides: MockActivityOverrides;
    }> = [
      {
        taskQueue: 'refactor-step-snapshot-rollback-critical',
        input: {
          ...baseInput,
          advisorBudget: 0,
        },
        overrides: {
          reviewActivity: async (input: ReviewInput) => {
            if (input.concern === 'correctness') {
              return {
                verdict: 'critical_block' as const,
                blocking_issues: ['credential leak in src/foo.ts'],
                suggestions: [],
              };
            }
            return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
          },
        },
      },
      {
        taskQueue: 'refactor-step-snapshot-rollback-max-iter',
        input: {
          ...baseInput,
          config: {
            ...DEFAULT_STEP_LOOP_CONFIG,
            maxIter: 1,
          },
        },
        overrides: {
          reviewActivity: async () => ({
            verdict: 'needs_revision' as const,
            blocking_issues: [],
            suggestions: ['tighten the implementation'],
          }),
        },
      },
      {
        taskQueue: 'refactor-step-snapshot-rollback-no-progress',
        input: baseInput,
        overrides: {
          reviewActivity: async () => ({
            verdict: 'needs_revision' as const,
            blocking_issues: [],
            suggestions: ['try again'],
          }),
        },
      },
    ];

    for (const testCase of rollbackCases) {
      const { calls } = await runWorkflow(testCase.taskQueue, testCase.input, {
        snapshotWorkdirActivity: async () => ({ snapped: true }),
        ...testCase.overrides,
      });
      const restoreIndex = calls.log.findIndex(
        (c) => c.name === 'restoreActivity' && readRestoreInput(c).paths === undefined,
      );
      const popIndex = calls.log.findIndex((c) => c.name === 'popWorkdirSnapshotActivity');

      expect(fullRestoreCalls(calls).length).toBe(1);
      expect(popCalls(calls).length).toBe(1);
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      expect(popIndex).toBeGreaterThan(restoreIndex);
    }
  });

  it('reverts reviewer drift by paths without full-step rollback', async () => {
    let statusCalls = 0;
    const { result, calls } = await runWorkflow('refactor-step-snapshot-drift-paths', baseInput, {
      snapshotWorkdirActivity: async () => ({ snapped: true }),
      statusPorcelainActivity: async () => {
        statusCalls += 1;
        if (statusCalls === 2) {
          return { entries: [' M src/foo.ts', ' M src/reviewer-drift.ts'] };
        }
        return { entries: [' M src/foo.ts'] };
      },
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error(`unexpected kind: ${result.kind}`);
    expect(result.record.outcome).toBe('converged');
    expect(result.record.driftReverts).toEqual(['src/reviewer-drift.ts']);

    const pathRestores = pathRestoreCalls(calls);
    expect(pathRestores.map((c) => readRestoreInput(c).paths)).toEqual([
      ['src/reviewer-drift.ts'],
    ]);
    expect(fullRestoreCalls(calls).length).toBe(0);
    expect(popCalls(calls).length).toBe(1);
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
    if (result.kind !== 'completed') throw new Error(`unexpected kind: ${result.kind}`);
    expect(result.record.outcome).toBe('parliament-skipped');

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
        reviewActivity: async (input: ReviewInput) => {
          if (input.concern === 'correctness') {
            return {
              verdict: 'critical_block' as const,
              blocking_issues: ['credential leak in src/foo.ts'],
              suggestions: ['rotate the leaked token'],
            };
          }
          return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
        },
        restoreActivity: async (input: RestoreInput) => {
          if (!input?.paths) restoreCalledWithoutPaths = true;
          return undefined;
        },
      },
    );

    expect(result.kind).toBe('circuit-broken');
    if (result.kind !== 'circuit-broken') throw new Error(`unexpected kind: ${result.kind}`);
    expect(result.record.outcome).toBe('rolled-back-critical-block');
    expect(result.circuitBroken.concern).toBe('correctness');
    expect(result.circuitBroken.bullets).toContain('credential leak in src/foo.ts');

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
    expect(result).not.toHaveProperty('record');
    expect(result).not.toHaveProperty('circuitBroken');

    expect(result.spawnCounts).toEqual({});
    expect(result.advisorConsumed).toBe(0);

    const names = calls.log.map((c) => c.name);
    expect(names).not.toContain('implementActivity');
    expect(names).not.toContain('reviewActivity');
  });
});
