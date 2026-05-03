import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { randomUUID } from 'crypto';
import { periodicRefactorWorkflow } from '../src/workflows';
import { getWorkflowBundle, makeMockActivities } from './helpers';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

describe('periodicRefactorWorkflow', () => {
  it('skips PR when planner returns no-op', async () => {
    const { activities, calls } = makeMockActivities({
      planActivity: async () => ({
        theme: 'no-op',
        rationale: 'repo already optimal',
        steps: [],
      }),
    });

    const taskQueue = 'periodic-test-noop';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-noop-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(result).toEqual({ skipped: 'no-op-plan' });
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('cloneRepoActivity');
    expect(names).toContain('planActivity');
    expect(names).toContain('cleanupWorkspaceActivity');
    // No implementer / reviewer should be invoked on no-op.
    expect(names).not.toContain('implementActivity');
    expect(names).not.toContain('reviewActivity');
  });

  it('skips Parliament when implementer diff is trivial', async () => {
    const { activities, calls } = makeMockActivities({
      diffStatActivity: async () => ({
        filesChanged: 1,
        insertions: 5,
        deletions: 2,
      }),
    });

    const taskQueue = 'periodic-test-trivial';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-trivial-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(result.prNumber).toBe(42);
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('planActivity');
    expect(names).toContain('implementActivity');
    expect(names).toContain('diffStatActivity');
    // Parliament must NOT run when the gate trips.
    expect(names).not.toContain('reviewActivity');
    expect(names).toContain('commitAllActivity');
    expect(names).toContain('createPRActivity');
  });

  it('runs Parliament and merges when diff is non-trivial and reviewers approve', async () => {
    const { activities, calls } = makeMockActivities();

    const taskQueue = 'periodic-test-happy';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-happy-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(result.prNumber).toBe(42);
    expect(result.prUrl).toContain('/pull/42');

    const names = calls.log.map((c) => c.name);
    // Each role and gate runs exactly once on the happy single-step path.
    expect(names.filter((n) => n === 'planActivity').length).toBe(1);
    expect(names.filter((n) => n === 'implementActivity').length).toBe(1);
    // Two reviewers run in parallel.
    expect(names.filter((n) => n === 'reviewActivity').length).toBe(2);
    expect(names).toContain('cloneRepoActivity');
    expect(names).toContain('commitAllActivity');
    expect(names).toContain('createPRActivity');
    expect(names).toContain('waitForCIActivity');
    expect(names).toContain('mergePRActivity');
  });

  it('rolls back and skips PR on critical_block from a reviewer', async () => {
    let restoreCalledWithoutPaths = false;
    const { activities, calls } = makeMockActivities({
      reviewActivity: async (input: any) => {
        if (input.concern === 'correctness') {
          return {
            verdict: 'critical_block' as const,
            blocking_issues: ['credential leak in src/foo.ts'],
            suggestions: [],
          };
        }
        return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
      },
      restoreActivity: async (input: any) => {
        if (!input?.paths) restoreCalledWithoutPaths = true;
        return undefined;
      },
      // After the full restore the working tree is clean → workflow returns
      // skipped: 'no-changes'.
      statusPorcelainActivity: async () => ({ entries: [] }),
    });

    const taskQueue = 'periodic-test-block';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-block-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(result).toEqual({ skipped: 'no-changes' });
    expect(restoreCalledWithoutPaths).toBe(true);
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('reviewActivity');
    expect(names).toContain('restoreActivity');
    // Must not commit/push after rollback.
    expect(names).not.toContain('commitAllActivity');
    expect(names).not.toContain('createPRActivity');
  });
});
