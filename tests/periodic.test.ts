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
  it('skips PR when codex produces no changes', async () => {
    const { activities, calls } = makeMockActivities({
      codexActivity: async () => ({
        message: 'nothing to do',
        raw: 'nothing to do',
        changedFiles: [],
      }),
    });

    const taskQueue = 'periodic-test-skip';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    const result = await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-skip-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(result).toEqual({ skipped: 'no-changes' });
    const names = calls.log.map((c) => c.name);
    expect(names).toEqual([
      'cloneRepoActivity',
      'codexActivity',
      'cleanupWorkspaceActivity',
    ]);
  });

  it('runs the full refactor → PR → merge happy path', async () => {
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
    expect(names).toContain('cloneRepoActivity');
    expect(names).toContain('codexActivity');
    expect(names).toContain('commitAllActivity');
    expect(names).toContain('pushBranchActivity');
    expect(names).toContain('createPRActivity');
    expect(names).toContain('waitForCIActivity');
    expect(names).toContain('checkConflictActivity');
    expect(names).toContain('mergePRActivity');
    expect(names).toContain('cleanupWorkspaceActivity');
  });

  it('sanitizes workflow IDs before using them as git branches', async () => {
    const { activities, calls } = makeMockActivities();

    const taskQueue = 'periodic-test-branch-sanitize';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic/test:${randomUUID()}`,
        args: [{ repoFullName: 'example/repo', autoMerge: false }],
      }),
    );

    expect(calls.log[0]).toMatchObject({
      name: 'cloneRepoActivity',
      args: [
        {
          branch: expect.stringMatching(/^agent\/refactor\/periodic-test-/),
          ref: 'main',
        },
      ],
    });
  });
});
