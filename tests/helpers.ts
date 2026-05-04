/**
 * Activity mock factory + shared workflow bundle for tests.
 */
import * as path from 'path';
import type { WorkflowStartOptions } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import type * as activities from '../src/activities';

let bundlePromise: Promise<WorkflowBundleWithSourceMap> | undefined;

/**
 * Bundle the workflow code once per test process. Re-using the bundle across
 * tests avoids paying the bundler cost N times.
 */
export function getWorkflowBundle(): Promise<WorkflowBundleWithSourceMap> {
  if (!bundlePromise) {
    bundlePromise = bundleWorkflowCode({
      workflowsPath: path.resolve(__dirname, '../src/workflows/index.ts'),
    });
  }
  return bundlePromise;
}

export interface ActivityCalls {
  log: Array<{ name: string; args: unknown[] }>;
}

type TestWorkflow = (...args: any[]) => Promise<any>;
export type MockActivityOverrides = Partial<typeof activities>;

export interface RunWorkflowWithMocksOptions<TWorkflow extends TestWorkflow> {
  env: TestWorkflowEnvironment;
  taskQueue: string;
  workflow: TWorkflow;
  workflowId: string;
  args: Parameters<TWorkflow>;
  activityOverrides?: MockActivityOverrides;
  catchErrors?: boolean;
}

export async function runWorkflowWithMocks<TWorkflow extends TestWorkflow>(
  options: RunWorkflowWithMocksOptions<TWorkflow> & { catchErrors: true },
): Promise<{ result: Awaited<ReturnType<TWorkflow>> | unknown; calls: ActivityCalls }>;
export async function runWorkflowWithMocks<TWorkflow extends TestWorkflow>(
  options: RunWorkflowWithMocksOptions<TWorkflow> & { catchErrors?: false },
): Promise<{ result: Awaited<ReturnType<TWorkflow>>; calls: ActivityCalls }>;
export async function runWorkflowWithMocks<TWorkflow extends TestWorkflow>({
  env,
  taskQueue,
  workflow,
  workflowId,
  args,
  activityOverrides,
  catchErrors = false,
}: RunWorkflowWithMocksOptions<TWorkflow>): Promise<{
  result: Awaited<ReturnType<TWorkflow>> | unknown;
  calls: ActivityCalls;
}> {
  const { activities: mockActivities, calls } = makeMockActivities(activityOverrides);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await getWorkflowBundle(),
    activities: mockActivities,
  });
  const startOptions = {
    taskQueue,
    workflowId,
    args,
  } as unknown as WorkflowStartOptions<TWorkflow>;
  const execution = env.client.workflow.execute(workflow, startOptions);
  const result = catchErrors
    ? await worker.runUntil(execution).catch((err: unknown) => err)
    : await worker.runUntil(execution);
  return { result, calls };
}

export function makeMockActivities(
  overrides: Partial<typeof activities> = {},
): { activities: typeof activities; calls: ActivityCalls } {
  const calls: ActivityCalls = { log: [] };

  function record<T>(name: string, fn: (...args: any[]) => Promise<T>) {
    return async (...args: any[]): Promise<T> => {
      calls.log.push({ name, args });
      return fn(...args);
    };
  }

  const defaults = {
    cloneRepoActivity: record('cloneRepoActivity', async () => ({
      workdir: '/tmp/agent-workspaces/mock',
      branch: 'agent/refactor/test',
      baseSha: 'deadbeef',
    })),
    ensureWorkdirActivity: record('ensureWorkdirActivity', async (input: { workdir: string }) => ({
      workdir: input.workdir,
    })),
    commitAllActivity: record('commitAllActivity', async () => ({
      committed: true,
      sha: 'cafebabe',
    })),
    commitAndPushActivity: record('commitAndPushActivity', async () => ({
      committed: true,
      pushed: true,
      sha: 'cafebabe',
    })),
    pushBranchActivity: record('pushBranchActivity', async () => undefined),
    checkConflictActivity: record('checkConflictActivity', async () => ({
      hasConflict: false,
      conflictedFiles: [],
    })),
    cleanupWorkspaceActivity: record('cleanupWorkspaceActivity', async () => undefined),
    createPRActivity: record('createPRActivity', async () => ({
      number: 42,
      url: 'https://github.com/example/repo/pull/42',
      branch: 'agent/refactor/test',
      baseBranch: 'main',
      repoFullName: 'example/repo',
    })),
    waitForCIActivity: record('waitForCIActivity', async () => ({
      status: 'success' as const,
      failedRunIds: [],
      failedJobNames: [],
    })),
    fetchFailedRunLogsActivity: record('fetchFailedRunLogsActivity', async () => 'log lines'),
    mergePRActivity: record('mergePRActivity', async () => undefined),
    observePRStateActivity: record('observePRStateActivity', async () => ({ state: 'OPEN' as const })),
    waitForPRStateActivity: record('waitForPRStateActivity', async () => ({
      state: 'MERGED' as const,
      timedOut: false,
    })),
    waitForPostMergeActivity: record('waitForPostMergeActivity', async () => 'merged' as const),
    // Generic codex activity — used by pr-lifecycle for CI self-heal and
    // merge-conflict resolution. The refactor pipeline does NOT route through
    // this; it uses the role-specific activities below.
    codexActivity: record('codexActivity', async () => ({
      message: 'codex stub message',
      changedFiles: ['src/foo.ts'],
    })),
    consultAdvisorActivity: record('consultAdvisorActivity', async () => ({
      verdict: 'retry' as const,
      rationale: 'mock advisor: retry',
    })),
    // Refactor-pipeline role activities. Defaults model the happy path: a
    // workflow-init context artifact, a 1-step plan, a non-trivial implement
    // diff, both reviewers OK on iter 0.
    extractContextArtifactActivity: record('extractContextArtifactActivity', async () => ({
      overview: 'stub repo: Temporal-driven refactor pipeline (TypeScript)',
      conventions: ['activities are pure functions', 'tests live as *.test.ts'],
      interfaces: ['Activity I/O is JSON-serializable'],
      generatedAt: '2026-05-03T00:00:00.000Z',
    })),
    planActivity: record('planActivity', async () => ({
      theme: 'tighten module boundaries',
      rationale: 'reduces inter-module coupling',
      steps: [
        {
          title: 'extract shared types',
          description: 'move shared interfaces into a dedicated module',
          critical_requirements: ['all existing unit tests still pass'],
        },
      ],
    })),
    implementActivity: record('implementActivity', async () => ({
      report: '## Changed files\n- src/foo.ts\n## Critical requirements\n- met',
    })),
    reviewActivity: record('reviewActivity', async () => ({
      verdict: 'ok' as const,
      blocking_issues: [],
      suggestions: [],
    })),
    // Git helpers used by the refactor workflow.
    diffStatActivity: record('diffStatActivity', async () => ({
      filesChanged: 4,
      insertions: 80,
      deletions: 20,
    })),
    diffTextActivity: record('diffTextActivity', async () => ({
      text: 'diff --git a/src/foo.ts b/src/foo.ts\n@@ stub diff @@',
      truncated: false,
    })),
    statusPorcelainActivity: record('statusPorcelainActivity', async () => ({
      entries: [' M src/foo.ts'],
    })),
    restoreActivity: record('restoreActivity', async () => undefined),
    snapshotWorkdirActivity: record('snapshotWorkdirActivity', async () => ({ snapped: false })),
    popWorkdirSnapshotActivity: record('popWorkdirSnapshotActivity', async () => undefined),
    reviewPlanActivity: record('reviewPlanActivity', async () => ({
      verdict: 'ok' as const,
      blocking_issues: [],
      suggestions: [],
    })),
    refinePlanActivity: record('refinePlanActivity', async () => ({
      theme: 'tighten module boundaries',
      rationale: 'reduces inter-module coupling',
      steps: [
        {
          title: 'extract shared types',
          description: 'move shared interfaces into a dedicated module',
          critical_requirements: ['all existing unit tests still pass'],
        },
      ],
    })),
  };

  const merged: typeof activities = { ...defaults } as unknown as typeof activities;
  for (const [name, fn] of Object.entries(overrides)) {
    if (typeof fn === 'function') {
      (merged as any)[name] = record(name, fn as any);
    }
  }
  return { activities: merged, calls };
}
