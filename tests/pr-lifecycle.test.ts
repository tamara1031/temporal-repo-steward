import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WorkflowFailedError } from '@temporalio/client';
import { randomUUID } from 'crypto';
import { robustPRMergeWorkflow } from '../src/workflows';
import { getWorkflowBundle, makeMockActivities } from './helpers';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

const baseInput = {
  repoFullName: 'example/repo',
  workdir: '/tmp/agent-workspaces/mock',
  branch: 'agent/refactor/test',
  baseBranch: 'main',
  prTitle: 'refactor(auto): test',
  prBody: 'body',
};

async function runWith(
  taskQueueName: string,
  acts: Parameters<typeof makeMockActivities>[0],
  input: Partial<typeof baseInput> & {
    maxFixIterations?: number;
    postMergePollAttempts?: number;
    postMergePollIntervalMs?: number;
  } = {},
) {
  const { activities, calls } = makeMockActivities(acts);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: taskQueueName,
    workflowBundle: await getWorkflowBundle(),
    activities,
  });
  const promise = env.client.workflow.execute(robustPRMergeWorkflow, {
    taskQueue: taskQueueName,
    workflowId: `${taskQueueName}-${randomUUID()}`,
    args: [{ ...baseInput, ...input }],
  });
  const result = await worker.runUntil(promise).catch((err: unknown) => err);
  return { result, calls };
}

describe('robustPRMergeWorkflow', () => {
  it('happy path: push → createPR → CI green → no conflict → merge → observe MERGED', async () => {
    const { result, calls } = await runWith('pr-happy', {});
    expect((result as any).prNumber).toBe(42);
    expect((result as any).iterations).toBe(0);
    expect((result as any).merged).toBe(true);
    expect((result as any).outcome).toBe('merged');
    expect((result as any).advisorConsults).toBe(0);

    const names = calls.log.map((c) => c.name);
    expect(names).toEqual([
      'pushBranchActivity', // initial setUpstream push
      'createPRActivity',
      'waitForCIActivity',
      'checkConflictActivity',
      'observePRStateActivity', // pre-merge state check
      'mergePRActivity',
      'observePRStateActivity', // post-merge poll
    ]);
  });

  it('short-circuits to merged-externally when pre-merge observation sees MERGED', async () => {
    const { result } = await runWith('pr-pre-merge-merged', {
      observePRStateActivity: async () => ({
        state: 'MERGED' as const,
        mergedAt: '2026-05-03T00:00:00.000Z',
      }),
    });
    expect((result as any).outcome).toBe('merged-externally');
    expect((result as any).merged).toBe(true);
  });

  it('treats pollUntilMerged CLOSED as closed-externally (not a thrown failure)', async () => {
    let observeCalls = 0;
    const { result } = await runWith(
      'pr-poll-closed',
      {
        observePRStateActivity: async () => {
          observeCalls += 1;
          // First call is the pre-merge gate — return OPEN to let the merge
          // request proceed. Second call is the post-merge poll — return
          // CLOSED to exercise the new clean-exit path.
          return { state: observeCalls === 1 ? ('OPEN' as const) : ('CLOSED' as const) };
        },
      },
      { postMergePollAttempts: 3, postMergePollIntervalMs: 1 },
    );
    expect((result as any).outcome).toBe('closed-externally');
    expect((result as any).merged).toBe(false);
  });

  it('reports merge-queued when post-merge poll never sees MERGED', async () => {
    const { result, calls } = await runWith(
      'pr-merge-queued',
      {
        observePRStateActivity: async () => ({ state: 'OPEN' as const }),
      },
      { postMergePollAttempts: 3, postMergePollIntervalMs: 1 },
    );
    expect((result as any).merged).toBe(false);
    expect((result as any).outcome).toBe('merge-queued');
    // 1 pre-merge state check + 3 post-merge poll attempts.
    expect(calls.log.filter((c) => c.name === 'observePRStateActivity').length).toBe(4);
  });

  it('returns closed-externally without throwing when CI loop sees PR closed', async () => {
    const { result } = await runWith('pr-closed-external', {
      waitForCIActivity: async () => ({
        status: 'closed' as const,
        failedRunIds: [],
        failedJobNames: [],
      }),
    });
    expect((result as any).outcome).toBe('closed-externally');
    expect((result as any).merged).toBe(false);
  });

  it('returns merged-externally when CI loop observes external merge', async () => {
    const { result } = await runWith('pr-merged-external', {
      waitForCIActivity: async () => ({
        status: 'merged' as const,
        failedRunIds: [],
        failedJobNames: [],
      }),
    });
    expect((result as any).outcome).toBe('merged-externally');
    expect((result as any).merged).toBe(true);
  });

  it('aborts when advisor returns abort on the 2nd self-heal', async () => {
    let advisorCalled = 0;
    const { result } = await runWith('pr-advisor-abort', {
      waitForCIActivity: async () => ({
        status: 'failure' as const,
        failedRunIds: ['1'],
        failedJobNames: ['ci'],
      }),
      consultAdvisorActivity: async () => {
        advisorCalled += 1;
        return { verdict: 'abort' as const, rationale: 'structural failure' };
      },
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);
    expect(advisorCalled).toBe(1);
  });

  it('CI failure → self-heal once → CI green → merge', async () => {
    let ciCalls = 0;
    const { result, calls } = await runWith('pr-self-heal', {
      waitForCIActivity: async () => {
        ciCalls += 1;
        if (ciCalls === 1) {
          return {
            status: 'failure' as const,
            failedRunIds: ['12345'],
            failedJobNames: ['lint'],
          };
        }
        return { status: 'success' as const, failedRunIds: [], failedJobNames: [] };
      },
    });

    expect((result as any).prNumber).toBe(42);
    expect((result as any).iterations).toBe(1);

    const names = calls.log.map((c) => c.name);
    // After CI failure: fetch logs → codex fix → commit → push → CI again → conflict check → merge.
    expect(names).toContain('fetchFailedRunLogsActivity');
    expect(names).toContain('codexActivity');
    expect(names.filter((n) => n === 'waitForCIActivity').length).toBe(2);
    expect(names.filter((n) => n === 'pushBranchActivity').length).toBe(2);
    expect(names).toContain('mergePRActivity');
  });

  it('conflict → resolve → CI green → merge', async () => {
    let conflictCalls = 0;
    const { result, calls } = await runWith('pr-conflict', {
      checkConflictActivity: async () => {
        conflictCalls += 1;
        if (conflictCalls === 1) {
          return {
            hasConflict: true,
            conflictedFiles: ['src/foo.ts'],
            diffSummary: '<<<<<<< HEAD\n=======\n>>>>>>> main\n',
          };
        }
        return { hasConflict: false, conflictedFiles: [] };
      },
    });

    expect((result as any).prNumber).toBe(42);
    expect((result as any).iterations).toBe(1);

    const names = calls.log.map((c) => c.name);
    expect(names.filter((n) => n === 'checkConflictActivity').length).toBe(2);
    expect(names).toContain('codexActivity');
    expect(names.filter((n) => n === 'pushBranchActivity').length).toBe(2);
    expect(names).toContain('mergePRActivity');
  });

  it('fails when codex produces no diff during self-heal', async () => {
    const { result } = await runWith('pr-no-diff', {
      waitForCIActivity: async () => ({
        status: 'failure' as const,
        failedRunIds: ['1'],
        failedJobNames: ['ci'],
      }),
      commitAllActivity: async () => ({ committed: false }),
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);
  });

  it('throws CITimeout when CI never settles', async () => {
    const { result } = await runWith('pr-ci-timeout', {
      waitForCIActivity: async () => ({
        status: 'timeout' as const,
        failedRunIds: [],
        failedJobNames: [],
      }),
    });
    expect(result).toBeInstanceOf(WorkflowFailedError);
  });

  it('exceeds max iterations when self-heal cannot converge', async () => {
    const { result } = await runWith(
      'pr-max-iters',
      {
        waitForCIActivity: async () => ({
          status: 'failure' as const,
          failedRunIds: ['x'],
          failedJobNames: ['ci'],
        }),
      },
      { maxFixIterations: 2 },
    );
    expect(result).toBeInstanceOf(WorkflowFailedError);
  });
});
