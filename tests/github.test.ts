import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { parsePRViewJSON } from '../src/activities/github';

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

function expectInvalidGitHubOutput(fn: () => unknown, messageParts: string[]): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('InvalidGitHubOutput');
    for (const messagePart of messageParts) {
      expect((err as Error).message).toContain(messagePart);
    }
    return;
  }
  throw new Error('Expected InvalidGitHubOutput ApplicationFailure');
}
