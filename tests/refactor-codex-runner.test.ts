import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodexExec } from '../src/activities/_internal/run-codex';
import { extractContextArtifactActivity } from '../src/activities/refactor/extract-context';
import { implementActivity } from '../src/activities/refactor/implement';
import { planActivity } from '../src/activities/refactor/plan';
import { refinePlanActivity } from '../src/activities/refactor/refine-plan';
import { reviewActivity } from '../src/activities/refactor/review';
import { reviewPlanActivity } from '../src/activities/refactor/review-plan';
import { PROMPTS } from '../src/activities/refactor/_internal/prompts';
import type { ContextArtifact, PlanOutput, PlanStep } from '../src/activities/refactor';

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

type PromptExampleCase = [string, () => string];

function extractExampleJsonText(prompt: string): string {
  const marker = 'Example JSON output:\n';
  const start = prompt.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const jsonStart = prompt.indexOf('{', start + marker.length);
  expect(jsonStart).toBeGreaterThanOrEqual(0);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = jsonStart; i < prompt.length; i += 1) {
    const char = prompt[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = inString;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return prompt.slice(jsonStart, i + 1);
      }
    }
  }

  throw new Error('Example JSON object was not closed');
}

function expectValidExampleJson(prompt: string): void {
  const exampleJson = extractExampleJsonText(prompt);

  expect(JSON.parse(exampleJson)).toEqual(expect.any(Object));
  expect(exampleJson).not.toMatch(/\[string,\s*\.\.\.\]|\[string,\.\.\.\]/);
  expect(exampleJson).not.toContain('//');
}

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

  it('keeps valid planner target_files in the implementer hard-scope section', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [
          {
            ...step,
            target_files: [
              'src/activities/refactor/_internal/parsers.ts',
              'tests/refactor-codex-runner.test.ts',
            ],
          },
        ],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await planActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
    });
    const prompt = PROMPTS.implement(contextArtifact, result.steps[0], []);

    expect(result.steps[0].target_files).toEqual([
      'src/activities/refactor/_internal/parsers.ts',
      'tests/refactor-codex-runner.test.ts',
    ]);
    expect(prompt).toContain(
      [
        '## Files you may modify',
        '- src/activities/refactor/_internal/parsers.ts',
        '- tests/refactor-codex-runner.test.ts',
      ].join('\n'),
    );
  });

  it('omits unsafe planner target_files before rendering implementer scope', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [
          {
            ...step,
            target_files: [
              'src/activities/refactor/_internal/parsers.ts',
              '',
              'tests/refactor-codex-runner.test.ts\n- package.json',
              '/tmp/escape.ts',
              '../outside.ts',
              'src/../outside.ts',
              'src/activities/refactor/_internal/parsers.ts',
            ],
          },
        ],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await planActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
    });
    const prompt = PROMPTS.implement(contextArtifact, result.steps[0], []);

    expect(result.steps[0].target_files).toEqual([
      'src/activities/refactor/_internal/parsers.ts',
    ]);
    expect(prompt).toContain('## Files you may modify\n- src/activities/refactor/_internal/parsers.ts');
    expect(prompt).not.toContain('package.json');
    expect(prompt).not.toContain('/tmp/escape.ts');
    expect(prompt).not.toContain('../outside.ts');
    expect(prompt).not.toContain('src/../outside.ts');
  });

  it('documents target_files in the plan-refiner prompt and preserves parser coercion', async () => {
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
    expect(prompt).toContain('Each step may include `target_files` with repo-relative paths');
    expectValidExampleJson(prompt);
    expect(result.steps[0].target_files).toEqual([
      'src/activities/refactor/_internal/prompts.ts',
    ]);
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt,
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('omits unsafe plan-refiner target_files before rendering implementer scope', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        theme: 'shared runner',
        rationale: 'keeps timeout handling consistent',
        steps: [
          {
            ...step,
            target_files: [
              'tests/refactor-codex-runner.test.ts',
              'C:\\temp\\escape.ts',
              'src/refactor\nREADME.md',
              '../../package.json',
              'tests/refactor-codex-runner.test.ts',
            ],
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
    const prompt = PROMPTS.implement(contextArtifact, result.steps[0], []);

    expect(result.steps[0].target_files).toEqual(['tests/refactor-codex-runner.test.ts']);
    expect(prompt).toContain('## Files you may modify\n- tests/refactor-codex-runner.test.ts');
    expect(prompt).not.toContain('C:\\temp\\escape.ts');
    expect(prompt).not.toContain('README.md');
    expect(prompt).not.toContain('../../package.json');
  });
});

describe('refactor JSON-output prompt examples', () => {
  const plan: PlanOutput = {
    theme: 'test coverage',
    rationale: 'improve reliability',
    steps: [step],
  };

  const promptExampleCases: PromptExampleCase[] = [
    ['context', () => PROMPTS.context],
    ['planner', () => PROMPTS.plan(contextArtifact, 'reduce repeated codex wiring')],
    ['plan reviewer feasibility', () => PROMPTS.reviewPlan(contextArtifact, 'feasibility', plan)],
    ['plan reviewer scope', () => PROMPTS.reviewPlan(contextArtifact, 'scope', plan)],
    ['plan refiner', () => PROMPTS.refinePlan(contextArtifact, plan, ['tighten file scope'])],
    ['reviewer correctness', () => PROMPTS.review(contextArtifact, 'correctness', step, '- old line\n+ new line')],
    ['reviewer quality', () => PROMPTS.review(contextArtifact, 'quality', step, '- old line\n+ new line')],
  ];

  it.each(promptExampleCases)('contains a parseable example JSON object for %s', (_name, buildPrompt) => {
    expectValidExampleJson(buildPrompt());
  });

  it('keeps concern-specific plan reviewer examples within concern scope', () => {
    const feasibilityPrompt = PROMPTS.reviewPlan(contextArtifact, 'feasibility', plan);
    const scopePrompt = PROMPTS.reviewPlan(contextArtifact, 'scope', plan);

    expect(feasibilityPrompt).toContain('requires a package install');
    expect(scopePrompt).toContain('combines prompt cleanup with unrelated activity timeout changes');
    expect(scopePrompt).not.toContain('requires a package install');
  });

  it('keeps concern-specific implementation reviewer examples within concern scope', () => {
    const correctnessPrompt = PROMPTS.review(contextArtifact, 'correctness', step, '- old line\n+ new line');
    const qualityPrompt = PROMPTS.review(contextArtifact, 'quality', step, '- old line\n+ new line');

    expect(correctnessPrompt).toContain('parser error path');
    expect(qualityPrompt).toContain('helper name hides');
    expect(qualityPrompt).not.toContain('parser error path');
    expect(qualityPrompt).not.toContain('malformed JSON');
  });
});

describe('reviewActivity', () => {
  beforeEach(() => {
    runCodexExecMock.mockReset();
  });

  it('uses the reviewer default timeout and correct prompt for correctness concern', async () => {
    const diff = '- old line\n+ new line';
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }),
      stdoutForLog: 'ignored',
    });

    const result = await reviewActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      step,
      diff,
      concern: 'correctness',
    });

    expect(result.verdict).toBe('ok');
    expect(result.blocking_issues).toEqual([]);
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.review(contextArtifact, 'correctness', step, diff),
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('routes the quality concern to a distinct prompt', async () => {
    const diff = '+   const x = null; // suspicious';
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        verdict: 'needs_revision',
        blocking_issues: ['unnecessary null initializer'],
        suggestions: [],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await reviewActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      step,
      diff,
      concern: 'quality',
    });

    expect(result.verdict).toBe('needs_revision');
    expect(result.blocking_issues).toContain('unnecessary null initializer');
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.review(contextArtifact, 'quality', step, diff),
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('propagates a reviewer timeout override', async () => {
    const diff = '-foo\n+bar';
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }),
      stdoutForLog: 'ignored',
    });

    await reviewActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      step,
      diff,
      concern: 'correctness',
      timeoutMs: 22_222,
    });

    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.review(contextArtifact, 'correctness', step, diff),
      timeoutMs: 22_222,
    });
  });
});

describe('reviewPlanActivity', () => {
  beforeEach(() => {
    runCodexExecMock.mockReset();
  });

  const plan: PlanOutput = {
    theme: 'test coverage',
    rationale: 'improve reliability',
    steps: [step],
  };

  it('uses the plan-reviewer default timeout and correct prompt for feasibility concern', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }),
      stdoutForLog: 'ignored',
    });

    const result = await reviewPlanActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      plan,
      concern: 'feasibility',
    });

    expect(result.verdict).toBe('ok');
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.reviewPlan(contextArtifact, 'feasibility', plan),
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('routes the scope concern to a distinct prompt', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        verdict: 'needs_revision',
        blocking_issues: ['steps are too coarse'],
        suggestions: ['split into two steps'],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await reviewPlanActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      plan,
      concern: 'scope',
    });

    expect(result.verdict).toBe('needs_revision');
    expect(result.blocking_issues).toContain('steps are too coarse');
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.reviewPlan(contextArtifact, 'scope', plan),
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('propagates a plan-reviewer timeout override', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }),
      stdoutForLog: 'ignored',
    });

    await reviewPlanActivity({
      workdir: '/tmp/workdir',
      contextArtifact,
      plan,
      concern: 'feasibility',
      timeoutMs: 33_333,
    });

    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.reviewPlan(contextArtifact, 'feasibility', plan),
      timeoutMs: 33_333,
    });
  });
});

describe('extractContextArtifactActivity', () => {
  beforeEach(() => {
    runCodexExecMock.mockReset();
  });

  it('uses the context prompt and default timeout, injecting generatedAt from input', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({
        overview: 'TypeScript Temporal workflow service',
        conventions: ['activities are pure functions'],
        interfaces: ['Activity I/O is JSON-serializable'],
      }),
      stdoutForLog: 'ignored',
    });

    const result = await extractContextArtifactActivity({
      workdir: '/tmp/workdir',
      generatedAt: '2026-05-04T00:00:00.000Z',
    });

    expect(result.overview).toBe('TypeScript Temporal workflow service');
    expect(result.conventions).toEqual(['activities are pure functions']);
    expect(result.interfaces).toEqual(['Activity I/O is JSON-serializable']);
    // generatedAt comes from the activity input, not from the codex JSON output.
    expect(result.generatedAt).toBe('2026-05-04T00:00:00.000Z');
    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.context,
      timeoutMs: 5 * 60 * 1000,
    });
  });

  it('propagates a context-extractor timeout override', async () => {
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ overview: 'repo', conventions: [], interfaces: [] }),
      stdoutForLog: 'ignored',
    });

    await extractContextArtifactActivity({
      workdir: '/tmp/workdir',
      generatedAt: '2026-05-04T00:00:00.000Z',
      timeoutMs: 44_444,
    });

    expect(runCodexExecMock).toHaveBeenCalledWith({
      workdir: '/tmp/workdir',
      prompt: PROMPTS.context,
      timeoutMs: 44_444,
    });
  });

  it('injects generatedAt from input even when codex JSON omits the field', async () => {
    // The codex output schema never includes generatedAt — it is always injected
    // by the activity from the workflow-deterministic input.generatedAt value.
    runCodexExecMock.mockResolvedValueOnce({
      lastMessage: JSON.stringify({ overview: 'small repo', conventions: [], interfaces: [] }),
      stdoutForLog: 'ignored',
    });

    const result = await extractContextArtifactActivity({
      workdir: '/tmp/workdir',
      generatedAt: '2026-01-01T12:00:00.000Z',
    });

    expect(result.generatedAt).toBe('2026-01-01T12:00:00.000Z');
  });
});
