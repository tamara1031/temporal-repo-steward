import { describe, expect, it } from 'vitest';
import { collectFeedback, summarizeReviews } from '../src/workflows/_internal/feedback';

const reviewOk = { blocking_issues: [], suggestions: [] };
const reviewNeeds = {
  verdict: 'needs_revision',
  blocking_issues: ['missing null check', 'unsafe cast'],
  suggestions: ['add early return', 'use type assertion', 'run tests'],
};
const reviewCritical = {
  verdict: 'critical_block',
  blocking_issues: ['credential leak'],
  suggestions: ['rotate token', 'add secret scanning'],
};

describe('collectFeedback', () => {
  it('returns empty array when all reviews are clean', () => {
    expect(collectFeedback([reviewOk, reviewOk], ['correctness', 'quality'])).toEqual([]);
  });

  it('prefixes each item with its concern label', () => {
    const result = collectFeedback([reviewNeeds], ['correctness']);
    expect(result).toContain('[correctness] missing null check');
    expect(result).toContain('[correctness] unsafe cast');
  });

  it('limits suggestions to maxSuggestions (default 2)', () => {
    // reviewNeeds has 3 suggestions; only the first 2 should appear
    const result = collectFeedback([reviewNeeds], ['correctness']);
    const suggs = result.filter((s) => s.startsWith('[correctness]'));
    // 2 blocking_issues + 2 suggestions = 4 items
    expect(suggs.length).toBe(4);
    expect(result).toContain('[correctness] add early return');
    expect(result).toContain('[correctness] use type assertion');
    expect(result).not.toContain('[correctness] run tests');
  });

  it('respects a custom maxSuggestions cap', () => {
    const result = collectFeedback([reviewNeeds], ['correctness'], undefined, 1);
    const suggs = result.filter((s) => s.includes('add early return'));
    expect(suggs.length).toBe(1);
    expect(result).not.toContain('[correctness] use type assertion');
  });

  it('collects from multiple reviewers in order', () => {
    const result = collectFeedback(
      [reviewNeeds, reviewCritical],
      ['correctness', 'quality'],
    );
    expect(result).toContain('[correctness] missing null check');
    expect(result).toContain('[quality] credential leak');
    // Order: correctness items come before quality items
    const corrIdx = result.indexOf('[correctness] missing null check');
    const qualIdx = result.indexOf('[quality] credential leak');
    expect(corrIdx).toBeLessThan(qualIdx);
  });

  it('skips the reviewer at skipIndex', () => {
    // Simulates the critical_block retry path where the blocker is collected
    // separately and skipIndex omits it from the "all others" pass.
    const result = collectFeedback(
      [reviewNeeds, reviewCritical],
      ['correctness', 'quality'],
      0, // skip correctness reviewer
    );
    expect(result).not.toContain('[correctness] missing null check');
    expect(result).toContain('[quality] credential leak');
  });

  it('returns empty when the only reviewer is skipped', () => {
    const result = collectFeedback([reviewCritical], ['quality'], 0);
    expect(result).toEqual([]);
  });

  it('handles empty reviews array', () => {
    expect(collectFeedback([], [])).toEqual([]);
  });

  it('works with PlanReviewOutput-shaped inputs (no verdict field required)', () => {
    // PlanReviewOutput has the same blocking_issues/suggestions shape.
    const planReview = {
      blocking_issues: ['plan too broad'],
      suggestions: ['narrow the scope'],
    };
    const result = collectFeedback([planReview], ['feasibility']);
    expect(result).toContain('[feasibility] plan too broad');
    expect(result).toContain('[feasibility] narrow the scope');
  });
});

describe('summarizeReviews', () => {
  it('preserves review order and zips concern labels by index', () => {
    expect(
      summarizeReviews(
        [reviewNeeds, reviewCritical],
        ['correctness', 'quality'],
      ).map((r) => r.concern),
    ).toEqual(['correctness', 'quality']);
  });

  it('copies verdicts through unchanged', () => {
    expect(summarizeReviews([reviewNeeds, reviewCritical], ['correctness', 'quality'])).toEqual([
      expect.objectContaining({ concern: 'correctness', verdict: 'needs_revision' }),
      expect.objectContaining({ concern: 'quality', verdict: 'critical_block' }),
    ]);
  });

  it('caps bullets at three after blocking issues then suggestions', () => {
    expect(summarizeReviews([reviewNeeds], ['correctness'])).toEqual([
      {
        concern: 'correctness',
        verdict: 'needs_revision',
        bullets: ['missing null check', 'unsafe cast', 'add early return'],
      },
    ]);
  });

  it('supports plan-review-shaped verdicts and concerns', () => {
    const planReview = {
      verdict: 'ok',
      blocking_issues: [],
      suggestions: ['keep scope narrow', 'preserve ordering', 'avoid drift', 'run tests'],
    };

    expect(summarizeReviews([planReview], ['scope'])).toEqual([
      {
        concern: 'scope',
        verdict: 'ok',
        bullets: ['keep scope narrow', 'preserve ordering', 'avoid drift'],
      },
    ]);
  });
});
