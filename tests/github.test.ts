import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { ERR_INVALID_GH_OUTPUT } from '../src/errors';
import { parsePRStateJSON, parsePRViewJSON } from '../src/activities/github';

describe('github activity helpers', () => {
  it('parses PR view JSON', () => {
    expect(
      parsePRViewJSON('{"number":42,"url":"https://github.com/example/repo/pull/42"}'),
    ).toEqual({
      number: 42,
      url: 'https://github.com/example/repo/pull/42',
    });
  });

  it('rejects malformed PR view JSON with a descriptive failure', () => {
    expectInvalidGitHubOutput(() => parsePRViewJSON('{'), [
      'gh pr view --json number,url returned malformed JSON',
    ]);
  });

  it('rejects PR view JSON missing the PR number', () => {
    expectInvalidGitHubOutput(
      () => parsePRViewJSON('{"url":"https://github.com/example/repo/pull/42"}'),
      ['gh pr view --json number,url output is missing numeric field "number"'],
    );
  });

  it('rejects PR view JSON missing the PR URL', () => {
    expectInvalidGitHubOutput(() => parsePRViewJSON('{"number":42}'), [
      'gh pr view --json number,url output is missing string field "url"',
    ]);
  });
});

describe('parsePRStateJSON', () => {
  it('parses MERGED with mergedAt timestamp', () => {
    expect(
      parsePRStateJSON('{"state":"MERGED","mergedAt":"2026-05-03T00:00:00Z"}'),
    ).toEqual({ state: 'MERGED', mergedAt: '2026-05-03T00:00:00Z' });
  });

  it('parses OPEN without mergedAt', () => {
    expect(parsePRStateJSON('{"state":"OPEN","mergedAt":null}')).toEqual({ state: 'OPEN' });
  });

  it('parses CLOSED without mergedAt', () => {
    expect(parsePRStateJSON('{"state":"CLOSED"}')).toEqual({ state: 'CLOSED' });
  });

  it('rejects unexpected state values', () => {
    expectInvalidGitHubOutput(() => parsePRStateJSON('{"state":"DRAFT"}'), [
      'gh pr view returned unexpected state',
    ]);
  });
});

function expectInvalidGitHubOutput(fn: () => unknown, messageParts: string[]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe(ERR_INVALID_GH_OUTPUT);
    for (const messagePart of messageParts) {
      expect((err as Error).message).toContain(messagePart);
    }
    return;
  }
  throw new Error(`Expected ${ERR_INVALID_GH_OUTPUT} ApplicationFailure`);
}
