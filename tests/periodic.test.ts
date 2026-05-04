import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { randomUUID } from 'crypto';
import { periodicRefactorWorkflow } from '../src/workflows';
import type { createPRActivity } from '../src/activities/github/create-pr';
import { runWorkflowWithMocks, type MockActivityOverrides } from './helpers';

let env: TestWorkflowEnvironment;
type CreatePRActivityInput = Parameters<typeof createPRActivity>[0];
type PeriodicInput = Parameters<typeof periodicRefactorWorkflow>[0];

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

async function runPeriodicWorkflow(
  taskQueue: string,
  workflowId: string,
  activityOverrides?: MockActivityOverrides,
  input: PeriodicInput = { repoFullName: 'example/repo' },
) {
  return runWorkflowWithMocks({
    env,
    taskQueue,
    workflow: periodicRefactorWorkflow,
    workflowId,
    args: [input],
    activityOverrides,
  });
}

describe('periodicRefactorWorkflow', () => {
  it('skips PR when planner returns no-op', async () => {
    const taskQueue = 'periodic-test-noop';
    const { result, calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-noop-${randomUUID()}`,
      {
        planActivity: async () => ({
          theme: 'no-op',
          rationale: 'repo already optimal',
          steps: [],
        }),
      },
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
    const taskQueue = 'periodic-test-trivial';
    const { result, calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-trivial-${randomUUID()}`,
      {
        diffStatActivity: async () => ({
          filesChanged: 1,
          insertions: 5,
          deletions: 2,
        }),
      },
    );

    expect(result.prNumber).toBe(42);
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('planActivity');
    expect(names).toContain('implementActivity');
    expect(names).toContain('diffStatActivity');
    // Parliament must NOT run when the gate trips.
    expect(names).not.toContain('reviewActivity');
    expect(names).toContain('commitAndPushActivity');
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
    const taskQueue = 'periodic-test-ctx';
    const { calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-ctx-${randomUUID()}`,
      {
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
      },
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
    let capturedBody = '';
    const taskQueue = 'periodic-test-happy';
    const { result, calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-happy-${randomUUID()}`,
      {
        createPRActivity: async (input: CreatePRActivityInput) => {
          capturedBody = input.body;
          return {
            number: 42,
            url: 'https://github.com/example/repo/pull/42',
            branch: input.branch,
            baseBranch: input.baseBranch,
            repoFullName: input.repoFullName,
          };
        },
      },
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
    expect(names).toContain('commitAndPushActivity');
    expect(names).toContain('createPRActivity');
    expect(names).toContain('waitForCIActivity');
    expect(names).toContain('mergePRActivity');
    expect(capturedBody).toContain('Used **7 / 22** codex calls.');
    expect(capturedBody).toContain('- context: 1');
    expect(capturedBody).toContain('- planner: 1');
    expect(capturedBody).toContain('- plan-reviewer: 2');
    expect(capturedBody).toContain('- implementer: 1');
    expect(capturedBody).toContain('- reviewer: 2');
  });

  it('rolls back and skips PR on critical_block when advisor agrees (verdict=abort)', async () => {
    let restoreCalledWithoutPaths = false;
    const taskQueue = 'periodic-test-block';
    const { result, calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-block-${randomUUID()}`,
      {
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
        // After the full restore the working tree is clean -> workflow returns
        // skipped: 'no-changes'.
        statusPorcelainActivity: async () => ({ entries: [] }),
      },
    );

    expect(result).toEqual({ skipped: 'no-changes', prOutcome: undefined } as any);
    expect(restoreCalledWithoutPaths).toBe(true);
    const names = calls.log.map((c) => c.name);
    expect(names).toContain('reviewActivity');
    expect(names).toContain('consultAdvisorActivity');
    expect(names).toContain('restoreActivity');
    // Must not commit/push after rollback.
    expect(names).not.toContain('commitAndPushActivity');
    expect(names).not.toContain('createPRActivity');
  });

  it('downgrades critical_block to needs_revision when advisor returns retry', async () => {
    let correctnessCalls = 0;
    let diffCalls = 0;
    const taskQueue = 'periodic-test-advisor-downgrade';
    const { calls } = await runPeriodicWorkflow(
      taskQueue,
      `periodic-advisor-downgrade-${randomUUID()}`,
      {
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
        // Vary diff text per call so iter 1's no-progress check sees real
        // progress and proceeds to Parliament again.
        diffTextActivity: async () => {
          diffCalls += 1;
          return {
            text: `diff --git a/src/foo${diffCalls}.ts b/src/foo${diffCalls}.ts\n@@ stub diff @@`,
            truncated: false,
          };
        },
        // Advisor downgrades critical_block to needs_revision.
        consultAdvisorActivity: async () => ({
          verdict: 'retry' as const,
          rationale: 'reviewer is over-cautious',
        }),
      },
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
  it('embeds advisor audit trail in the PR body', async () => {
    let correctnessCalls = 0;
    let diffCalls = 0;
    let capturedBody = '';
    const taskQueue = 'periodic-test-advisor-body';
    await runPeriodicWorkflow(
      taskQueue,
      `periodic-advisor-body-${randomUUID()}`,
      {
        reviewActivity: async (input: any) => {
          if (input.concern === 'correctness') {
            correctnessCalls += 1;
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
        diffTextActivity: async () => {
          diffCalls += 1;
          return {
            text: `diff --git a/src/foo${diffCalls}.ts b/src/foo${diffCalls}.ts\n@@ stub diff @@`,
            truncated: false,
          };
        },
        consultAdvisorActivity: async () => ({
          verdict: 'retry' as const,
          rationale: 'looks over-cautious; one more pass should land it',
          suggestedAction: 'add the suggested guard and retry',
        }),
        createPRActivity: async (input: CreatePRActivityInput) => {
          capturedBody = input.body;
          return {
            number: 42,
            url: 'https://github.com/example/repo/pull/42',
            branch: input.branch,
            baseBranch: input.baseBranch,
            repoFullName: input.repoFullName,
          };
        },
      },
    );

    expect(capturedBody).toContain('## Advisor consults');
    expect(capturedBody).toContain('Gate: `critical-block`');
    expect(capturedBody).toContain('**Verdict**: `retry`');
    expect(capturedBody).toContain('looks over-cautious');
    expect(capturedBody).toContain('add the suggested guard and retry');
  });

  it('sanitizes branch names when workflowId contains colons (e.g. from schedules)', async () => {
    let capturedBranch = '';
    const taskQueue = 'periodic-test-sanitize';
    const workflowId = 'periodic-refactor-repo-2026-05-03T10:00:00Z';
    await runPeriodicWorkflow(
      taskQueue,
      workflowId,
      {
        cloneRepoActivity: async (input: any) => {
          capturedBranch = input.branch;
          return { workdir: '/tmp/workdir', branch: input.branch, baseSha: 'sha' };
        },
      },
    );

    expect(capturedBranch).toBe('agent/refactor/periodic-refactor-repo-2026-05-03T10-00-00Z');
    expect(capturedBranch).not.toContain(':');
  });
});
