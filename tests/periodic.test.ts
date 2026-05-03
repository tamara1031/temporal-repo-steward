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

  it('extracts the Context Artifact once and threads it to plan/implement/review', async () => {
    const ctxArtifact = {
      overview: 'fixture repo overview',
      conventions: ['fixture-convention-A'],
      interfaces: ['fixture-interface-X'],
      generatedAt: '2026-05-03T00:00:00.000Z',
    };
    let planSawCtx = false;
    let implementSawCtx = false;
    let reviewSawCtx = 0;
    const { activities, calls } = makeMockActivities({
      extractContextArtifactActivity: async () => ctxArtifact,
      planActivity: async (input: any) => {
        planSawCtx = input?.contextArtifact?.overview === ctxArtifact.overview;
        return {
          theme: 'fixture-theme',
          rationale: 'fixture',
          steps: [
            {
              title: 's',
              description: 'd',
              critical_requirements: ['tests still pass'],
            },
          ],
        };
      },
      implementActivity: async (input: any) => {
        implementSawCtx = input?.contextArtifact?.overview === ctxArtifact.overview;
        return { report: 'ok' };
      },
      reviewActivity: async (input: any) => {
        if (input?.contextArtifact?.overview === ctxArtifact.overview) reviewSawCtx += 1;
        return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
      },
    });

    const taskQueue = 'periodic-test-ctx';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-ctx-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    expect(planSawCtx).toBe(true);
    expect(implementSawCtx).toBe(true);
    // Two reviewers each receive the artifact.
    expect(reviewSawCtx).toBe(2);
    const names = calls.log.map((c) => c.name);
    // Context extractor runs exactly once per workflow.
    expect(names.filter((n) => n === 'extractContextArtifactActivity').length).toBe(1);
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

  it('rolls back and skips PR on critical_block when advisor agrees (verdict=abort)', async () => {
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
      // Advisor agrees: keep the rollback.
      consultAdvisorActivity: async () => ({
        verdict: 'abort' as const,
        rationale: 'agreed: critical security issue',
      }),
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

    expect(result).toEqual({ skipped: 'no-changes', prOutcome: undefined } as any);
    expect(restoreCalledWithoutPaths).toBe(true);
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('reviewActivity');
    expect(names).toContain('consultAdvisorActivity');
    expect(names).toContain('restoreActivity');
    // Must not commit/push after rollback.
    expect(names).not.toContain('commitAllActivity');
    expect(names).not.toContain('createPRActivity');
  });

  it('downgrades critical_block to needs_revision when advisor returns retry', async () => {
    let correctnessCalls = 0;
    let statusCalls = 0;
    const { activities, calls } = makeMockActivities({
      reviewActivity: async (input: any) => {
        if (input.concern === 'correctness') {
          correctnessCalls += 1;
          // First iteration trips the gate; second iteration approves.
          if (correctnessCalls === 1) {
            return {
              verdict: 'critical_block' as const,
              blocking_issues: ['over-cautious flag'],
              suggestions: [],
            };
          }
        }
        return { verdict: 'ok' as const, blocking_issues: [], suggestions: [] };
      },
      // Vary porcelain output per call so iter 1's no-progress check
      // (`arraysEqual(prev, current)`) sees real progress and proceeds to
      // Parliament again.
      statusPorcelainActivity: async () => {
        statusCalls += 1;
        return { entries: [` M src/foo${statusCalls}.ts`] };
      },
      // Advisor downgrades critical_block to needs_revision.
      consultAdvisorActivity: async () => ({
        verdict: 'retry' as const,
        rationale: 'reviewer is over-cautious',
      }),
    });

    const taskQueue = 'periodic-test-advisor-downgrade';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await getWorkflowBundle(),
      activities,
    });

    await worker.runUntil(
      env.client.workflow.execute(periodicRefactorWorkflow, {
        taskQueue,
        workflowId: `periodic-advisor-downgrade-${randomUUID()}`,
        args: [{ repoFullName: 'example/repo' }],
      }),
    );

    const names = calls.log.map((c) => c.name);
    expect(names).toContain('consultAdvisorActivity');
    // Advisor downgrade lets iter 1 re-run the implementer.
    expect(names.filter((n) => n === 'implementActivity').length).toBe(2);
    // Workflow must NOT have done a full restore (no `restoreActivity` with
    // an undefined `paths` field).
    const fullRestores = calls.log.filter(
      (c) => c.name === 'restoreActivity' && !(c.args[0] as any)?.paths,
    );
    expect(fullRestores.length).toBe(0);
  });
});
