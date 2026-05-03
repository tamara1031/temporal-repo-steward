import { describe, expect, it } from 'vitest';
import { SpawnCounter } from '../src/workflows/_internal/spawn-budget';

describe('SpawnCounter', () => {
  it('rejects invalid consumption without changing totals', () => {
    const counter = new SpawnCounter(3);
    counter.consume('context', 1);

    expect(() => counter.consume('implementer', -1)).toThrow(RangeError);
    expect(() => counter.consume('implementer', Number.NaN)).toThrow(RangeError);
    expect(() => counter.consume('implementer', Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => counter.consume('implementer', 3)).toThrow(RangeError);

    expect(counter.summary()).toEqual({
      total: 1,
      cap: 3,
      perRole: { context: 1 },
    });
  });

  it('reconciles valid child spawn counts into the per-role summary', () => {
    const counter = new SpawnCounter(6);
    counter.consume('context', 1);

    counter.reconcile({ planner: 1, 'plan-reviewer': 2 });
    counter.reconcile({ implementer: 1, reviewer: 1 });

    expect(counter.summary()).toEqual({
      total: 6,
      cap: 6,
      perRole: {
        context: 1,
        planner: 1,
        'plan-reviewer': 2,
        implementer: 1,
        reviewer: 1,
      },
    });
  });

  it('rejects invalid child reconciliation atomically', () => {
    const counter = new SpawnCounter(4);
    counter.consume('context', 1);

    expect(() => counter.reconcile({ planner: 1, reviewer: Number.NaN })).toThrow(RangeError);
    expect(() => counter.reconcile({ planner: 1, reviewer: 3 })).toThrow(RangeError);

    expect(counter.summary()).toEqual({
      total: 1,
      cap: 4,
      perRole: { context: 1 },
    });
  });
});
