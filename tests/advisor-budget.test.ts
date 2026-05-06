import { describe, expect, it } from 'vitest';
import { AdvisorBudget } from '../src/workflows/_internal/advisor';
import { assertNonNegativeInt } from '../src/workflows/_internal/spawn-budget';

describe('AdvisorBudget', () => {
  it('starts empty with full remaining budget', () => {
    const b = new AdvisorBudget(3);
    expect(b.used()).toBe(0);
    expect(b.remaining()).toBe(3);
    expect(b.canConsume()).toBe(true);
  });

  it('tryConsume decrements remaining and returns true while budget is available', () => {
    const b = new AdvisorBudget(2);
    expect(b.tryConsume()).toBe(true);
    expect(b.used()).toBe(1);
    expect(b.remaining()).toBe(1);
    expect(b.tryConsume()).toBe(true);
    expect(b.used()).toBe(2);
    expect(b.remaining()).toBe(0);
  });

  it('tryConsume returns false and does not change state when budget is exhausted', () => {
    const b = new AdvisorBudget(1);
    expect(b.tryConsume()).toBe(true);

    expect(b.tryConsume()).toBe(false);
    expect(b.used()).toBe(1);
    expect(b.remaining()).toBe(0);
  });

  it('canConsume returns false once the cap is reached', () => {
    const b = new AdvisorBudget(1);
    expect(b.canConsume()).toBe(true);
    b.tryConsume();
    expect(b.canConsume()).toBe(false);
  });

  it('remaining never goes below zero even when addConsumed overshoots', () => {
    const b = new AdvisorBudget(2);
    b.tryConsume();
    b.addConsumed(10); // simulates a runaway child that reported back more than allowed
    expect(b.remaining()).toBe(0);
  });

  it('addConsumed accumulates usage from child workflows', () => {
    const b = new AdvisorBudget(5);
    b.tryConsume();      // parent consumed 1
    b.addConsumed(2);   // child consumed 2
    expect(b.used()).toBe(3);
    expect(b.remaining()).toBe(2);
  });

  it('addConsumed silently ignores negative values', () => {
    const b = new AdvisorBudget(3);
    b.tryConsume();
    b.addConsumed(-5);
    expect(b.used()).toBe(1);
    expect(b.remaining()).toBe(2);
  });

  it('budget with cap 0 is immediately exhausted', () => {
    const b = new AdvisorBudget(0);
    expect(b.canConsume()).toBe(false);
    expect(b.tryConsume()).toBe(false);
    expect(b.remaining()).toBe(0);
    expect(b.used()).toBe(0);
  });

  it('used reflects the total consumed across tryConsume and addConsumed', () => {
    const b = new AdvisorBudget(10);
    b.tryConsume();
    b.tryConsume();
    b.addConsumed(3);
    expect(b.used()).toBe(5);
  });

  // Constructor validation — matches the same invariant enforced by SpawnCounter.
  it('constructor rejects a negative cap', () => {
    expect(() => new AdvisorBudget(-1)).toThrow(RangeError);
  });

  it('constructor rejects a fractional cap', () => {
    // A cap of 1.5 would silently allow 2 consults (0 < 1.5, 1 < 1.5 both true).
    expect(() => new AdvisorBudget(1.5)).toThrow(RangeError);
  });

  it('constructor rejects NaN', () => {
    expect(() => new AdvisorBudget(Number.NaN)).toThrow(RangeError);
  });

  it('constructor rejects Infinity', () => {
    expect(() => new AdvisorBudget(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('constructor accepts zero (immediately exhausted)', () => {
    expect(() => new AdvisorBudget(0)).not.toThrow();
  });
});

describe('assertNonNegativeInt', () => {
  it('is a named export from spawn-budget', () => {
    expect(typeof assertNonNegativeInt).toBe('function');
  });

  it('does not throw for valid non-negative integers', () => {
    expect(() => assertNonNegativeInt('test', 0)).not.toThrow();
    expect(() => assertNonNegativeInt('test', 1)).not.toThrow();
    expect(() => assertNonNegativeInt('test', 100)).not.toThrow();
  });

  it('throws RangeError for negative numbers', () => {
    expect(() => assertNonNegativeInt('test', -1)).toThrow(RangeError);
  });

  it('throws RangeError for fractions', () => {
    expect(() => assertNonNegativeInt('test', 0.5)).toThrow(RangeError);
  });

  it('throws RangeError for NaN', () => {
    expect(() => assertNonNegativeInt('test', Number.NaN)).toThrow(RangeError);
  });

  it('throws RangeError for Infinity', () => {
    expect(() => assertNonNegativeInt('test', Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('includes the label in the error message', () => {
    expect(() => assertNonNegativeInt('advisor cap', -1)).toThrow(/advisor cap/);
  });
});
