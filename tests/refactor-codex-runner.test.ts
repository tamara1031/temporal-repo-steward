import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodexExec } from '../src/activities/_internal/run-codex';
import { implementActivity } from '../src/activities/refactor/implement';
import { planActivity } from '../src/activities/refactor/plan';
import { refinePlanActivity } from '../src/activities/refactor/refine-plan';
import { PROMPTS } from '../src/activities/refactor/_internal/prompts';
import type { ContextArtifact, PlanStep } from '../src/activities/refactor';

vi.mock('../src/activities/_internal/run-codex', () => ({
  runCodexExec: vi.fn(),
}));

const runCodexExecMock = vi.mocked(runCodexExec);

const contextArtifact: ContextArtifact = {
  overview: 'TypeScript Temporal service',
  conventions: ['activities parse codex output locally'],
  interfaces: ['Activity input and output types are stable'],
  generatedAt: '2026-05-03T00:00:00.000Z',
};

const step: PlanStep = {
  title: 'Extract shared runner',
  description: 'Route refactor role activities through an internal Codex runner helper.',
  critical_requirements: ['existing activity I/O types stay unchanged'],
};

describe('refactor role Codex runner', () => {
  beforeEach(() => {
    runCodexExecMock.mockReset();
  });

  it('uses the planner default timeout while preserving its generated prompt and parser', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [step],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await planActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      brief: 'reduce repeated codex wiring',
    });

    expect(result.theme).toBe('shared runner');
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.plan(contextArtifact, 'reduce repeated codex wiring'),
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('propagates a planner timeout override', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [step],
      }),
      stdoutForLog: 'ignored',
    });

    await planActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      timeoutMs: 12_345,
    });

    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.plan(contextArtifact, undefined),
      timeoutMs: 12_345,
    });
  });

  it('uses the implementer default timeout while preserving prompt and report truncation', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: 'x'.repeat(20 * 1024),
      stdoutForLog: 'ignored',
    });

    const result = await implementActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      step,
      priorFeedback: ['tighten the test assertion'],
    });

    expect(result.report).toHaveLength(16 * 1024);
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.implement(contextArtifact, step, ['tighten the test assertion']),
      timeoutMs: 30 * 60 * 1000,
    });
  });

  it('propagates an implementer timeout override', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: 'implementation report',
      stdoutForLog: 'ignored',
    });

    await implementActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      step,
      priorFeedback: [],
      timeoutMs: 67_890,
    });

    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.implement(contextArtifact, step, []),
      timeoutMs: 67_890,
    });
  });

  it('documents target_files in the plan-refiner schema and preserves parser coercion', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [
          {
            ...step,
            target_files: ['src/activities/refactor/_internal/prompts.ts'],
          },
        ],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await refinePlanActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      plan: {
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [step],
      },
      feedback: ['add expected file scope'],
    });

    const prompt = PROMPTS.refinePlan(contextArtifact, {
      theme: 'shared runner',
      rationale: 'keeps timeout handling consistent',
      steps: [step],
    }, ['add expected file scope']);
    expect(prompt).toContain(
      '"target_files": [string, ...]   // repo-relative paths the implementer is expected to modify; omit if unknown',
    );
    expect(result.steps[0].target_files).toEqual([
      'src/activities/refactor/_internal/prompts.ts',
    ]);
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt,
      timeoutMs: 5 * 60 * 1000,
    });
  });
});
