import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import {
  classifyCheck,
  decideCIStatus,
  extractRunId,
  parseStatusCheckRollupJSON,
  type RollupCheck,
} from '../src/activities/github-ci';

describe('github CI helpers', () => {
  it('parses missing statusCheckRollup as empty', () => {
    expect(parseStatusCheckRollupJSON('{}')).toEqual([]);
  });

  it('parses statusCheckRollup entries', () => {
    expect(
      parseStatusCheckRollupJSON('{"statusCheckRollup":[{"name":"lint","conclusion":"SUCCESS"}]}'),
    ).toEqual([{ name: 'lint', conclusion: 'SUCCESS' }]);
  });

  it('rejects malformed statusCheckRollup JSON with a descriptive failure', () => {
    expectInvalidGitHubOutput(() => parseStatusCheckRollupJSON('{'), [
      'gh pr view --json statusCheckRollup returned malformed JSON',
    ]);
  });

  it('rejects non-array statusCheckRollup output', () => {
    expectInvalidGitHubOutput(
      () => parseStatusCheckRollupJSON('{"statusCheckRollup":{}}'),
      ['gh pr view --json statusCheckRollup output field "statusCheckRollup" must be an array'],
    );
  });

  it('rejects statusCheckRollup entries without names', () => {
    expectInvalidGitHubOutput(
      () => parseStatusCheckRollupJSON('{"statusCheckRollup":[{"conclusion":"SUCCESS"}]}'),
      ['statusCheckRollup[0] is missing string field "name"'],
    );
  });

  it.each([
    ['successful check run', [{ name: 'test', conclusion: 'SUCCESS' }], 'success'],
    [
      'successful completed check run',
      [{ name: 'test', state: 'COMPLETED', conclusion: 'SUCCESS' }],
      'success',
    ],
    ['pending status context', [{ name: 'test', state: 'PENDING' }], 'pending'],
    ['queued check run', [{ name: 'test', state: 'QUEUED' }], 'pending'],
    ['in-progress check run', [{ name: 'test', state: 'IN_PROGRESS' }], 'pending'],
    ['failed check run', [{ name: 'test', conclusion: 'FAILURE' }], 'failure'],
    ['cancelled check run', [{ name: 'test', conclusion: 'CANCELLED' }], 'failure'],
    ['timed-out check run', [{ name: 'test', conclusion: 'TIMED_OUT' }], 'failure'],
    ['action-required check run', [{ name: 'test', conclusion: 'ACTION_REQUIRED' }], 'failure'],
    ['startup-failure check run', [{ name: 'test', conclusion: 'STARTUP_FAILURE' }], 'failure'],
    ['neutral check run', [{ name: 'test', conclusion: 'NEUTRAL' }], 'success'],
    ['skipped check run', [{ name: 'test', conclusion: 'SKIPPED' }], 'success'],
    ['stale check run', [{ name: 'test', conclusion: 'STALE' }], 'success'],
    ['successful status context', [{ name: 'legacy-ci', state: 'SUCCESS' }], 'success'],
    ['errored status context', [{ name: 'legacy-ci', state: 'ERROR' }], 'failure'],
    ['failed status context', [{ name: 'legacy-ci', state: 'FAILURE' }], 'failure'],
    ['expected status context', [{ name: 'required', state: 'EXPECTED' }], 'pending'],
  ] satisfies Array<[string, RollupCheck[], ReturnType<typeof decideCIStatus>['status']]>)(
    'classifies %s as %s',
    (_name, checks, status) => {
      expect(decideCIStatus(checks).status).toBe(status);
    },
  );

  it('collects failed run ids and job names from failed checks only', () => {
    expect(
      decideCIStatus([
        {
          name: 'lint',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/example/repo/actions/runs/1234567890/job/9876543210',
        },
        {
          name: 'test',
          conclusion: 'TIMED_OUT',
          detailsUrl: 'https://github.com/example/repo/actions/runs/1234567890/job/9876543211',
        },
        {
          name: 'docs',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/example/repo/actions/runs/222/job/333',
        },
      ]),
    ).toEqual({
      status: 'failure',
      failedRunIds: ['1234567890'],
      failedJobNames: ['lint', 'test'],
    });
  });

  it('de-duplicates failed run ids collected from duplicate failed details URLs', () => {
    expect(
      decideCIStatus([
        {
          name: 'lint',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/example/repo/actions/runs/1234567890/job/9876543210',
        },
        {
          name: 'test',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/example/repo/actions/runs/1234567890/job/9876543210',
        },
      ]),
    ).toEqual({
      status: 'failure',
      failedRunIds: ['1234567890'],
      failedJobNames: ['lint', 'test'],
    });
  });

  it('returns no failed runs or job names for only passing outcomes', () => {
    expect(
      decideCIStatus([
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'docs', conclusion: 'NEUTRAL' },
        { name: 'optional', conclusion: 'SKIPPED' },
        { name: 'legacy-ci', state: 'SUCCESS' },
      ]),
    ).toEqual({
      status: 'success',
      failedRunIds: [],
      failedJobNames: [],
    });
  });

  it('treats a rollup with no checks as success without failed runs or job names', () => {
    expect(decideCIStatus([])).toEqual({
      status: 'success',
      failedRunIds: [],
      failedJobNames: [],
    });
  });

  it('keeps mixed pending and done rollups pending without failures', () => {
    expect(
      decideCIStatus([
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'required', state: 'EXPECTED' },
        { name: 'build', state: 'PENDING' },
      ]),
    ).toEqual({
      status: 'pending',
      failedRunIds: [],
      failedJobNames: [],
    });
  });

  it('handles malformed and missing optional fields as not done rather than failed', () => {
    expect(
      decideCIStatus([
        { name: 'unknown' },
        {
          name: 'malformed',
          state: 'COMPLETED',
          detailsUrl: 'https://github.com/example/repo/actions/runs/not-a-number/job/1',
        },
      ]),
    ).toEqual({
      status: 'pending',
      failedRunIds: [],
      failedJobNames: [],
    });
  });

  it('classifies expected status contexts as not done', () => {
    expect(classifyCheck({ name: 'required', state: 'EXPECTED' })).toEqual({
      done: false,
      passed: false,
    });
  });

  it('extracts run ids from action URLs only', () => {
    expect(extractRunId('https://github.com/example/repo/actions/runs/123/job/456')).toBe('123');
    expect(extractRunId('https://ci.example.com/build/123')).toBeUndefined();
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
