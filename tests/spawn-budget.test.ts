import { describe, it, expect } from 'vitest';
import { SpawnCounter } from '../src/workflows/_internal/spawn-budget';

describe('SpawnCounter', () => {
  it('starts at zero with full remaining budget', () => {
    const c = new SpawnCounter(10);
    expect(c.remaining()).toBe(10);
    expect(c.summary()).toEqual({ total: 0, cap: 10, perRole: {} });
  });

  it('canConsume is true up to the cap boundary', () => {
    const c = new SpawnCounter(5);
    expect(c.canConsume(5)).toBe(true);
    expect(c.canConsume(6)).toBe(false);
  });

  it('canConsume rejects non-integers and negatives', () => {
    const c = new SpawnCounter(10);
    expect(c.canConsume(-1)).toBe(false);
    expect(c.canConsume(1.5)).toBe(false);
    expect(c.canConsume(Number.NaN)).toBe(false);
  });

  it('consume tracks by role and reduces remaining', () => {
    const c = new SpawnCounter(10);
    c.consume('planner', 1);
    c.consume('implementer', 2);
    expect(c.remaining()).toBe(7);
    expect(c.summary().perRole).toEqual({ planner: 1, implementer: 2 });
    expect(c.summary().total).toBe(3);
  });

  it('consume accumulates counts within the same role', () => {
    const c = new SpawnCounter(10);
    c.consume('reviewer', 2);
    c.consume('reviewer', 3);
    expect(c.summary().perRole['reviewer']).toBe(5);
  });

  it('consume rejects invalid counts without changing totals', () => {
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

  it('reconcile applies valid child spawn counts into the per-role summary', () => {
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

  it('reconcile rejects invalid child counts atomically without partial application', () => {
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

  it('summary returns a snapshot copy, not a live reference', () => {
    const c = new SpawnCounter(10);
    c.consume('planner', 1);
    const snap = c.summary();
    c.consume('planner', 1);
    expect(snap.total).toBe(1);
    expect(snap.perRole['planner']).toBe(1);
  });
});
