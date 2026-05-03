import { describe, expect, it } from 'vitest';
import { renderReport, type ReportInput, type StepRecord } from '../src/workflows/_internal/refactor-report';
import type { PlanOutput, PlanStep } from '../src/activities/refactor';

const step = (title: string): PlanStep => ({
  title,
  description: `${title} description`,
  critical_requirements: [`${title} requirement`],
});

const record = (s: PlanStep, overrides: Partial<StepRecord> = {}): StepRecord => ({
  step: s,
  outcome: 'converged',
  iters: 1,
  implementReports: ['implemented'],
  parliamentSummary: [],
  driftReverts: [],
  ...overrides,
});

const reportInput = (overrides: Partial<ReportInput> = {}): ReportInput => {
  const plannedStep = step('planned');
  const plan: PlanOutput = {
    theme: 'theme',
    rationale: 'rationale',
    steps: [plannedStep],
  };
  return {
    plan,
    droppedFromPlan: [],
    stepRecords: [record(plannedStep)],
    spawnSummary: { total: 1, cap: 8, perRole: { implementer: 1 } },
    branch: 'agent/refactor/test',
    advisorAudits: [],
    stepCap: 2,
    ...overrides,
  };
};

describe('renderReport', () => {
  it('reports capped planner step count from plan.steps.length', () => {
    const planned = [step('one'), step('two'), step('three'), step('four')];
    const markdown = renderReport(
      reportInput({
        plan: {
          theme: 'capped',
          rationale: 'planner returned too much',
          steps: planned,
        },
        stepRecords: [record(planned[0])],
        droppedFromPlan: [planned[2], planned[3]],
        stepCap: 2,
      }),
    );

    expect(markdown).toContain('Dropped by step cap');
    expect(markdown).toContain('Planner returned 4 steps; cap is 2. Dropped:');
    expect(markdown).not.toContain('Planner returned 3 steps; cap is 2. Dropped:');
    expect(markdown).toContain('- three');
    expect(markdown).toContain('- four');
  });

  it('renders circuit-breaker reports with existing outcome strings', () => {
    const blocked = step('blocked step');
    const markdown = renderReport(
      reportInput({
        plan: { theme: 'blocked', rationale: 'critical issue', steps: [blocked] },
        stepRecords: [
          record(blocked, {
            outcome: 'rolled-back-critical-block',
            iters: 2,
          }),
        ],
        circuitBroken: {
          step: blocked,
          concern: 'correctness',
          bullets: ['credential leak in src/foo.ts'],
        },
      }),
    );

    expect(markdown).toContain('Circuit breaker fired');
    expect(markdown).toContain('Reviewer **correctness** issued `critical_block` on step "blocked step".');
    expect(markdown).toContain('### Step: blocked step');
    expect(markdown).toContain('rolled-back-critical-block');
    expect(markdown).toContain('- credential leak in src/foo.ts');
  });

  it('renders advisor audit output for replies, failures, and exhausted budget', () => {
    const markdown = renderReport(
      reportInput({
        advisorAudits: [
          {
            gate: 'critical-block',
            situation: 'reviewer found a critical issue',
            reply: {
              verdict: 'retry',
              rationale: 'one more pass is justified',
              suggestedAction: 'tighten the guard',
            },
          },
          {
            gate: 'ci-self-heal',
            situation: 'tests failed after merge',
            error: 'advisor timed out while reading logs',
          },
          {
            gate: 'no-diff',
            situation: 'implementer produced no diff',
          },
        ],
      }),
    );

    expect(markdown).toContain('## Advisor consults');
    expect(markdown).toContain('### Gate: `critical-block`');
    expect(markdown).toContain('- **Verdict**: `retry`');
    expect(markdown).toContain('- **Rationale**: one more pass is justified');
    expect(markdown).toContain('- **Suggested action**: tighten the guard');
    expect(markdown).toContain('### Gate: `ci-self-heal`');
    expect(markdown).toContain('(advisor call failed: advisor timed out while reading logs)');
    expect(markdown).toContain('### Gate: `no-diff`');
    expect(markdown).toContain('(advisor budget exhausted; default path taken)');
  });

  it('omits dropped-step section when no planner steps were dropped', () => {
    const planned = [step('one'), step('two')];
    const markdown = renderReport(
      reportInput({
        plan: { theme: 'uncapped', rationale: 'within cap', steps: planned },
        stepRecords: [record(planned[0]), record(planned[1])],
        droppedFromPlan: [],
        stepCap: 2,
      }),
    );

    expect(markdown).not.toContain('Dropped by step cap');
    expect(markdown).not.toContain('Dropped:');
    expect(markdown).toContain('### Step: one');
    expect(markdown).toContain('### Step: two');
  });
});
