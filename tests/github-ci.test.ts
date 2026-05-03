import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { ERR_INVALID_GH_OUTPUT } from '../src/errors';
import {
  classifyCheck,
  decideCIStatus,
  evaluateStabilization,
  extractRunId,
  parseStatusCheckRollupJSON,
  type RollupCheck,
  type RollupSnapshot,
} from '../src/activities/github/_internal/ci-rollup';

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

describe('evaluateStabilization', () => {
  const checks = (...entries: RollupCheck[]): RollupCheck[] => entries;

  it('starts a fresh window on the first observation', () => {
    const out = evaluateStabilization(
      undefined,
      checks({ name: 'lint', conclusion: 'SUCCESS' }),
      1_000,
      60_000,
    );
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') {
      expect(out.next.firstObservedAt).toBe(1_000);
      expect(out.next.signature).toEqual(['lint\0SUCCESS']);
    }
  });

  it('keeps waiting while elapsed time is below the threshold', () => {
    const prev: RollupSnapshot = {
      signature: ['lint\0SUCCESS'],
      firstObservedAt: 1_000,
    };
    const out = evaluateStabilization(
      prev,
      checks({ name: 'lint', conclusion: 'SUCCESS' }),
      30_000,
      60_000,
    );
    expect(out).toEqual({ kind: 'wait', next: prev });
  });

  it('settles once the same signature has held for the full window', () => {
    const prev: RollupSnapshot = {
      signature: ['lint\0SUCCESS'],
      firstObservedAt: 1_000,
    };
    const out = evaluateStabilization(
      prev,
      checks({ name: 'lint', conclusion: 'SUCCESS' }),
      61_000,
      60_000,
    );
    expect(out).toEqual({ kind: 'settle' });
  });

  it('resets the window when a new check appears mid-stabilization (the registration race)', () => {
    const prev: RollupSnapshot = {
      signature: ['lint\0SUCCESS'],
      firstObservedAt: 1_000,
    };
    const out = evaluateStabilization(
      prev,
      checks(
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'test', conclusion: 'SUCCESS' },
      ),
      50_000,
      60_000,
    );
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') {
      expect(out.next.firstObservedAt).toBe(50_000);
      expect(out.next.signature).toEqual([
        'lint\0SUCCESS',
        'test\0SUCCESS',
      ]);
    }
  });

  it('resets the window when the same job name flips conclusion (e.g. re-run)', () => {
    const prev: RollupSnapshot = {
      signature: ['lint\0SUCCESS'],
      firstObservedAt: 1_000,
    };
    // Same name but a re-run dropped it back to IN_PROGRESS — `decideCIStatus`
    // would actually flip the overall decision to `pending` here, but the
    // stabilization helper must still treat the signature as changed so that
    // a hypothetical "same name, different terminal verdict" (e.g.
    // `SUCCESS → NEUTRAL`) also restarts the window.
    const out = evaluateStabilization(
      prev,
      checks({ name: 'lint', conclusion: 'NEUTRAL' }),
      50_000,
      60_000,
    );
    expect(out.kind).toBe('wait');
    if (out.kind === 'wait') {
      expect(out.next.firstObservedAt).toBe(50_000);
      expect(out.next.signature).toEqual(['lint\0NEUTRAL']);
    }
  });

  it('treats check ordering as irrelevant — only the sorted set matters', () => {
    const prev = evaluateStabilization(
      undefined,
      checks(
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'test', conclusion: 'SUCCESS' },
      ),
      1_000,
      60_000,
    );
    expect(prev.kind).toBe('wait');
    const next = evaluateStabilization(
      prev.kind === 'wait' ? prev.next : undefined,
      checks(
        { name: 'test', conclusion: 'SUCCESS' },
        { name: 'lint', conclusion: 'SUCCESS' },
      ),
      61_000,
      60_000,
    );
    expect(next).toEqual({ kind: 'settle' });
  });

  it('handles the "no checks configured" rollup like any other signature', () => {
    const first = evaluateStabilization(undefined, [], 1_000, 60_000);
    expect(first.kind).toBe('wait');
    const second = evaluateStabilization(
      first.kind === 'wait' ? first.next : undefined,
      [],
      61_000,
      60_000,
    );
    expect(second).toEqual({ kind: 'settle' });
  });

  it('pins the failure-asymmetry contract — failures must short-circuit, never stabilize', () => {
    // Implementation contract: callers must check `decideCIStatus(...).status`
    // before invoking `evaluateStabilization`. A failed rollup never reaches
    // here. We assert that contract by showing decideCIStatus would already
    // return `failure` for these inputs — so wait-for-ci's branch order
    // (failure → return immediately; success → stabilize) stays correct.
    expect(
      decideCIStatus([
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'test', conclusion: 'FAILURE' },
      ]).status,
    ).toBe('failure');
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
