import { describe, expect, it } from 'vitest';
import { AdvisorBudget } from '../src/workflows/_internal/advisor';

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
});
