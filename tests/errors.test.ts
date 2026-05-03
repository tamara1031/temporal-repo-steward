/**
 * Tests for the error catalog (src/errors.ts) and the refactor activity parsers
 * that are the primary consumers of the typed error constants.
 *
 * Parser tests live here (rather than in a separate parsers.test.ts) because
 * the parsers are the highest-risk consumers: they decide whether a codex
 * response surfaces as a non-retryable failure (PlannerOutputInvalid) or as a
 * graceful coercion (needs_revision).  Covering their boundary behaviour gives
 * the most direct signal that the error catalog wiring is correct end-to-end.
 */

import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/activity';

import {
  PROXY_NON_RETRYABLE,
  ADVISOR_PROXY_NON_RETRYABLE,
  ERR_PLANNER_OUTPUT_INVALID,
  ERR_ADVISOR_OUTPUT_INVALID,
  ERR_RATE_LIMITED,
  ERR_CODEX_INVOCATION,
  type KnownErrorType,
} from '../src/errors';

import {
  parseContextOutput,
  parsePlanOutput,
  parsePlanReviewOutput,
  parseReviewOutput,
} from '../src/activities/refactor/_internal/parsers';

// ---------------------------------------------------------------------------
// Catalog structural invariants
// ---------------------------------------------------------------------------

describe('error catalog structural invariants', () => {
  it('ADVISOR_PROXY_NON_RETRYABLE is a superset of PROXY_NON_RETRYABLE', () => {
    for (const errType of PROXY_NON_RETRYABLE) {
      expect(ADVISOR_PROXY_NON_RETRYABLE).toContain(errType);
    }
  });

  it('ADVISOR_PROXY_NON_RETRYABLE contains AdvisorOutputInvalid and PROXY_NON_RETRYABLE does not', () => {
    expect(ADVISOR_PROXY_NON_RETRYABLE).toContain(ERR_ADVISOR_OUTPUT_INVALID);
    expect(PROXY_NON_RETRYABLE).not.toContain(ERR_ADVISOR_OUTPUT_INVALID);
  });

  it('neither PROXY_NON_RETRYABLE nor ADVISOR_PROXY_NON_RETRYABLE contain retryable types', () => {
    const retryable: KnownErrorType[] = [ERR_RATE_LIMITED, ERR_CODEX_INVOCATION];
    for (const errType of retryable) {
      expect(PROXY_NON_RETRYABLE).not.toContain(errType);
      expect(ADVISOR_PROXY_NON_RETRYABLE).not.toContain(errType);
    }
  });

  it('PROXY_NON_RETRYABLE has no duplicate entries', () => {
    const seen = new Set<string>();
    for (const errType of PROXY_NON_RETRYABLE) {
      expect(seen.has(errType), `duplicate entry: ${errType}`).toBe(false);
      seen.add(errType);
    }
  });

  it('ADVISOR_PROXY_NON_RETRYABLE has no duplicate entries', () => {
    const seen = new Set<string>();
    for (const errType of ADVISOR_PROXY_NON_RETRYABLE) {
      expect(seen.has(errType), `duplicate entry: ${errType}`).toBe(false);
      seen.add(errType);
    }
  });
});

// ---------------------------------------------------------------------------
// parsePlanOutput — the only parser that throws (PlannerOutputInvalid)
// ---------------------------------------------------------------------------

describe('parsePlanOutput', () => {
  it('parses a valid plan JSON blob', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        theme: 'test coverage',
        rationale: 'to improve reliability',
        steps: [
          { title: 'add unit tests', description: 'write vitest specs', critical_requirements: ['must pass'] },
        ],
      }),
    );
    expect(result.theme).toBe('test coverage');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].title).toBe('add unit tests');
  });

  it('parses plan JSON embedded in markdown fence preamble', () => {
    const raw = '```json\n{"theme":"x","rationale":"y","steps":[{"title":"t","description":"d","critical_requirements":["r"]}]}\n```';
    const result = parsePlanOutput(raw);
    expect(result.theme).toBe('x');
  });

  it('drops steps that are missing required fields (title, description, critical_requirements)', () => {
    const raw = JSON.stringify({
      theme: 'cleanup',
      rationale: 'reason',
      steps: [
        { title: '', description: 'no title', critical_requirements: ['r'] },
        { title: 'ok', description: 'has all', critical_requirements: [] },
        { title: 'good', description: 'complete', critical_requirements: ['req'] },
      ],
    });
    const result = parsePlanOutput(raw);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].title).toBe('good');
  });

  it('parses target_files when present and non-empty', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        theme: 'narrow scope',
        rationale: 'focus the implementer',
        steps: [
          {
            title: 'update parser',
            description: 'tighten the parser',
            critical_requirements: ['lint passes'],
            target_files: ['src/activities/refactor/_internal/parsers.ts'],
          },
        ],
      }),
    );
    expect(result.steps[0].target_files).toEqual([
      'src/activities/refactor/_internal/parsers.ts',
    ]);
  });

  it('omits target_files when absent from the planner output', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        theme: 'x',
        rationale: 'y',
        steps: [{ title: 't', description: 'd', critical_requirements: ['r'] }],
      }),
    );
    expect(result.steps[0].target_files).toBeUndefined();
  });

  it('omits target_files when the field is not a string array (coercion)', () => {
    const result = parsePlanOutput(
      JSON.stringify({
        theme: 'x',
        rationale: 'y',
        steps: [
          { title: 't', description: 'd', critical_requirements: ['r'], target_files: 'not-array' },
        ],
      }),
    );
    expect(result.steps[0].target_files).toBeUndefined();
  });

  it('throws PlannerOutputInvalid when codex returns no JSON object', () => {
    expect(() => parsePlanOutput('Here is my analysis...')).toThrow(
      expect.objectContaining({
        type: ERR_PLANNER_OUTPUT_INVALID,
      }),
    );
  });

  it('throws PlannerOutputInvalid when the theme field is missing', () => {
    const raw = JSON.stringify({ rationale: 'reason', steps: [] });
    expect(() => parsePlanOutput(raw)).toThrow(
      expect.objectContaining({
        type: ERR_PLANNER_OUTPUT_INVALID,
        message: expect.stringContaining('theme'),
      }),
    );
  });

  it('thrown PlannerOutputInvalid is an ApplicationFailure', () => {
    try {
      parsePlanOutput('not json');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).type).toBe(ERR_PLANNER_OUTPUT_INVALID);
      return;
    }
    throw new Error('expected parsePlanOutput to throw');
  });
});

// ---------------------------------------------------------------------------
// parseReviewOutput — coerces rather than throws; needs activity context for log
// ---------------------------------------------------------------------------

function inActivity<R>(fn: () => R): Promise<R> {
  return new MockActivityEnvironment().run<[], R, () => Promise<R>>(async () => fn());
}

describe('parseReviewOutput', () => {
  it('parses a valid ok verdict', async () => {
    const result = await inActivity(() =>
      parseReviewOutput(JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }), 'correctness'),
    );
    expect(result.verdict).toBe('ok');
  });

  it('parses a valid critical_block verdict', async () => {
    const result = await inActivity(() =>
      parseReviewOutput(
        JSON.stringify({ verdict: 'critical_block', blocking_issues: ['unsafe cast'], suggestions: [] }),
        'correctness',
      ),
    );
    expect(result.verdict).toBe('critical_block');
    expect(result.blocking_issues).toContain('unsafe cast');
  });

  it('coerces unknown verdict to needs_revision instead of throwing', async () => {
    const result = await inActivity(() =>
      parseReviewOutput(JSON.stringify({ verdict: 'wontfix', blocking_issues: [], suggestions: [] }), 'quality'),
    );
    expect(result.verdict).toBe('needs_revision');
  });

  it('coerces non-JSON output to needs_revision with an explanatory blocking issue', async () => {
    const result = await inActivity(() =>
      parseReviewOutput('I have thoroughly reviewed the code and found no issues.', 'quality'),
    );
    expect(result.verdict).toBe('needs_revision');
    expect(result.blocking_issues[0]).toContain('reviewer-quality returned non-JSON');
  });
});

// ---------------------------------------------------------------------------
// parsePlanReviewOutput — same coerce-not-throw pattern as parseReviewOutput
// ---------------------------------------------------------------------------

describe('parsePlanReviewOutput', () => {
  it('parses a valid ok verdict for feasibility concern', async () => {
    const result = await inActivity(() =>
      parsePlanReviewOutput(JSON.stringify({ verdict: 'ok', blocking_issues: [], suggestions: [] }), 'feasibility'),
    );
    expect(result.verdict).toBe('ok');
  });

  it('coerces non-JSON to needs_revision', async () => {
    const result = await inActivity(() =>
      parsePlanReviewOutput('looks fine to me', 'scope'),
    );
    expect(result.verdict).toBe('needs_revision');
    expect(result.blocking_issues[0]).toContain('plan-reviewer-scope returned non-JSON');
  });
});

// ---------------------------------------------------------------------------
// parseContextOutput — always graceful (returns fallback, never throws)
// ---------------------------------------------------------------------------

describe('parseContextOutput', () => {
  it('parses a valid context JSON blob', async () => {
    const raw = JSON.stringify({
      overview: 'monorepo',
      conventions: ['use strict mode'],
      interfaces: ['interface Foo {}'],
    });
    const result = await inActivity(() => parseContextOutput(raw));
    expect(result.overview).toBe('monorepo');
    expect(result.conventions).toEqual(['use strict mode']);
  });

  it('falls back to raw text overview when codex returns non-JSON', async () => {
    const result = await inActivity(() => parseContextOutput('This is a repo with TypeScript.'));
    expect(result.overview).toContain('This is a repo');
    expect(result.conventions).toEqual([]);
    expect(result.interfaces).toEqual([]);
  });

  it('filters non-string entries from conventions array', async () => {
    const raw = JSON.stringify({
      overview: 'repo',
      conventions: ['valid', 42, null, 'also valid'],
      interfaces: [],
    });
    const result = await inActivity(() => parseContextOutput(raw));
    expect(result.conventions).toEqual(['valid', 'also valid']);
  });
});
