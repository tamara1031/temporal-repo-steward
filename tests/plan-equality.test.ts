import { describe, expect, it } from 'vitest';
import type { PlanOutput } from '../src/activities/refactor';
import { plansEqual } from '../src/workflows/_internal/plan-equality';

function plan(overrides: Partial<PlanOutput> = {}): PlanOutput {
  return {
    theme: 'tighten module boundaries',
    rationale: 'reduce coupling',
    steps: [
      {
        title: 'extract shared types',
        description: 'move shared interfaces into a dedicated module',
        critical_requirements: ['tests pass', 'workflow determinism remains intact'],
        target_files: ['src/activities/refactor/_internal/types.ts', 'tests/errors.test.ts'],
      },
    ],
    ...overrides,
  };
}

describe('plansEqual', () => {
  it('compares equal plans field-by-field regardless of object key insertion order', () => {
    const first = plan();
    const second: PlanOutput = {
      steps: [
        {
          target_files: ['src/activities/refactor/_internal/types.ts', 'tests/errors.test.ts'],
          critical_requirements: ['tests pass', 'workflow determinism remains intact'],
          description: 'move shared interfaces into a dedicated module',
          title: 'extract shared types',
        },
      ],
      rationale: 'reduce coupling',
      theme: 'tighten module boundaries',
    };

    expect(plansEqual(first, second)).toBe(true);
  });

  it('detects theme and rationale changes', () => {
    expect(plansEqual(plan(), plan({ theme: 'different theme' }))).toBe(false);
    expect(plansEqual(plan(), plan({ rationale: 'different rationale' }))).toBe(false);
  });

  it('detects step field changes', () => {
    expect(
      plansEqual(
        plan(),
        plan({
          steps: [
            {
              title: 'different title',
              description: 'move shared interfaces into a dedicated module',
              critical_requirements: ['tests pass', 'workflow determinism remains intact'],
              target_files: ['src/activities/refactor/_internal/types.ts', 'tests/errors.test.ts'],
            },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      plansEqual(
        plan(),
        plan({
          steps: [
            {
              title: 'extract shared types',
              description: 'different description',
              critical_requirements: ['tests pass', 'workflow determinism remains intact'],
              target_files: ['src/activities/refactor/_internal/types.ts', 'tests/errors.test.ts'],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('keeps critical_requirements order-sensitive', () => {
    expect(
      plansEqual(
        plan(),
        plan({
          steps: [
            {
              title: 'extract shared types',
              description: 'move shared interfaces into a dedicated module',
              critical_requirements: ['workflow determinism remains intact', 'tests pass'],
              target_files: ['src/activities/refactor/_internal/types.ts', 'tests/errors.test.ts'],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('distinguishes target_files presence and keeps target_files order-sensitive', () => {
    expect(
      plansEqual(
        plan(),
        plan({
          steps: [
            {
              title: 'extract shared types',
              description: 'move shared interfaces into a dedicated module',
              critical_requirements: ['tests pass', 'workflow determinism remains intact'],
            },
          ],
        }),
      ),
    ).toBe(false);

    expect(
      plansEqual(
        plan(),
        plan({
          steps: [
            {
              title: 'extract shared types',
              description: 'move shared interfaces into a dedicated module',
              critical_requirements: ['tests pass', 'workflow determinism remains intact'],
              target_files: ['tests/errors.test.ts', 'src/activities/refactor/_internal/types.ts'],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
