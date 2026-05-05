import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';
import { ERR_INVALID_GH_OUTPUT } from '../src/errors';
import {
  mapPostMergeStateToOutcome,
  parsePRStateJSON,
} from '../src/activities/github';
import { pollPostMergeOutcome } from '../src/activities/github/_internal/post-merge-poll';
import { parsePRViewJSON } from '../src/activities/github/_internal/pr-view';
import {
  DEFAULT_PR_STATE_MAX_WAIT_MS,
  DEFAULT_PR_STATE_POLL_INTERVAL_MS,
  pollPRState,
} from '../src/activities/github/_internal/wait-pr-state-poll';
import type { PRLifecycleState } from '../src/activities/github';

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

describe('mapPostMergeStateToOutcome', () => {
  it('maps MERGED to merged', () => {
    expect(mapPostMergeStateToOutcome('MERGED', false)).toBe('merged');
  });

  it('maps CLOSED to closed-externally', () => {
    expect(mapPostMergeStateToOutcome('CLOSED', false)).toBe('closed-externally');
  });

  it('keeps OPEN non-terminal while polling budget remains', () => {
    expect(mapPostMergeStateToOutcome('OPEN', false)).toBeUndefined();
  });

  it('maps OPEN to merge-queued only after the polling budget is exhausted', () => {
    expect(mapPostMergeStateToOutcome('OPEN', true)).toBe('merge-queued');
  });
});

describe('pollPostMergeOutcome', () => {
  const expectedDefaultAttempts = 6;
  const expectedDefaultPollIntervalMs = 10_000;

  it('continues polling while OPEN and stops when MERGED is observed', async () => {
    const poll = makePostMergePoll(['OPEN', 'MERGED']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 3, pollIntervalMs: 10, maxActivityWaitMs: 100 },
        poll.deps,
      ),
    ).resolves.toBe('merged');

    expect(poll.observed()).toBe(2);
    expect(poll.sleeps).toEqual([10]);
  });

  it('stops immediately when CLOSED is observed', async () => {
    const poll = makePostMergePoll(['CLOSED']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 3, pollIntervalMs: 10, maxActivityWaitMs: 100 },
        poll.deps,
      ),
    ).resolves.toBe('closed-externally');

    expect(poll.observed()).toBe(1);
    expect(poll.sleeps).toEqual([]);
  });

  it('returns merge-queued when OPEN remains through the configured attempts', async () => {
    const poll = makePostMergePoll(['OPEN', 'OPEN', 'OPEN']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 3, pollIntervalMs: 10, maxActivityWaitMs: 100 },
        poll.deps,
      ),
    ).resolves.toBe('merge-queued');

    expect(poll.observed()).toBe(3);
    expect(poll.sleeps).toEqual([10, 10]);
  });

  it('returns merge-queued when OPEN remains through the activity-owned wait budget', async () => {
    const poll = makePostMergePoll(['OPEN', 'OPEN', 'OPEN']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 10, pollIntervalMs: 10, maxActivityWaitMs: 15 },
        poll.deps,
      ),
    ).resolves.toBe('merge-queued');

    expect(poll.observed()).toBe(3);
    expect(poll.sleeps).toEqual([10, 5]);
  });

  it.each([0, -10])('normalizes %s ms poll intervals before sleeping', async (pollIntervalMs) => {
    const poll = makePostMergePoll(['OPEN']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 3, pollIntervalMs, maxActivityWaitMs: 2 },
        poll.deps,
      ),
    ).resolves.toBe('merge-queued');

    expect(poll.sleeps).toEqual([2]);
    expect(poll.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it('returns merge-queued without sleeping when the activity-owned wait budget is exhausted', async () => {
    const poll = makePostMergePoll(['OPEN']);

    await expect(
      pollPostMergeOutcome(
        { prNumber: 42, maxPollAttempts: 3, pollIntervalMs: 10, maxActivityWaitMs: 0 },
        poll.deps,
      ),
    ).resolves.toBe('merge-queued');

    expect(poll.observed()).toBe(1);
    expect(poll.sleeps).toEqual([]);
  });

  it('uses the existing default post-merge attempts and poll interval', async () => {
    const poll = makePostMergePoll(['OPEN']);

    await expect(pollPostMergeOutcome({ prNumber: 42 }, poll.deps)).resolves.toBe(
      'merge-queued',
    );

    expect(poll.observed()).toBe(expectedDefaultAttempts);
    expect(poll.sleeps).toHaveLength(expectedDefaultAttempts - 1);
    expect(poll.sleeps.every((ms) => ms === expectedDefaultPollIntervalMs)).toBe(true);
  });
});

describe('pollPRState', () => {
  it('returns when a default target state is observed', async () => {
    const poll = makePRStatePoll(['OPEN', 'MERGED']);

    await expect(
      pollPRState({ prNumber: 42, pollIntervalMs: 10, maxWaitMs: 100 }, poll.deps),
    ).resolves.toEqual({
      state: 'MERGED',
      mergedAt: '2026-05-03T00:00:00Z',
      timedOut: false,
    });

    expect(poll.observed()).toBe(2);
    expect(poll.sleeps).toEqual([10]);
  });

  it('honors custom target states', async () => {
    const poll = makePRStatePoll(['OPEN']);

    await expect(
      pollPRState(
        { prNumber: 42, targetStates: ['OPEN'], pollIntervalMs: 10, maxWaitMs: 100 },
        poll.deps,
      ),
    ).resolves.toEqual({ state: 'OPEN', timedOut: false });

    expect(poll.observed()).toBe(1);
    expect(poll.sleeps).toEqual([]);
  });

  it('returns the last observed state on timeout', async () => {
    const poll = makePRStatePoll(['OPEN', 'OPEN']);

    await expect(
      pollPRState({ prNumber: 42, pollIntervalMs: 10, maxWaitMs: 20 }, poll.deps),
    ).resolves.toEqual({ state: 'OPEN', timedOut: true });

    expect(poll.observed()).toBe(2);
    expect(poll.sleeps).toEqual([10, 10]);
  });

  it('clips the final sleep and returns the last observed non-target state on timeout', async () => {
    const poll = makePRStatePoll(['OPEN', 'CLOSED']);

    await expect(
      pollPRState(
        { prNumber: 42, targetStates: ['MERGED'], pollIntervalMs: 10, maxWaitMs: 15 },
        poll.deps,
      ),
    ).resolves.toEqual({ state: 'CLOSED', timedOut: true });

    expect(poll.observed()).toBe(2);
    expect(poll.sleeps).toEqual([10, 5]);
  });

  it.each([0, -10])('normalizes %s ms poll intervals before sleeping', async (pollIntervalMs) => {
    const poll = makePRStatePoll(['OPEN']);

    await expect(
      pollPRState(
        { prNumber: 42, targetStates: ['MERGED'], pollIntervalMs, maxWaitMs: 2 },
        poll.deps,
      ),
    ).resolves.toEqual({ state: 'OPEN', timedOut: true });

    expect(poll.sleeps).toEqual([2]);
    expect(poll.sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it('falls back to OPEN when timeout occurs before the first observation', async () => {
    const poll = makePRStatePoll(['MERGED'], 1);

    await expect(pollPRState({ prNumber: 42, maxWaitMs: 0 }, poll.deps)).resolves.toEqual({
      state: 'OPEN',
      timedOut: true,
    });

    expect(poll.observed()).toBe(0);
    expect(poll.sleeps).toEqual([]);
  });

  it('uses the existing default poll interval and max wait', async () => {
    const poll = makePRStatePoll(['OPEN']);

    await expect(pollPRState({ prNumber: 42 }, poll.deps)).resolves.toEqual({
      state: 'OPEN',
      timedOut: true,
    });

    expect(poll.observed()).toBe(DEFAULT_PR_STATE_MAX_WAIT_MS / DEFAULT_PR_STATE_POLL_INTERVAL_MS);
    expect(poll.sleeps).toHaveLength(
      DEFAULT_PR_STATE_MAX_WAIT_MS / DEFAULT_PR_STATE_POLL_INTERVAL_MS,
    );
    expect(poll.sleeps.every((ms) => ms === DEFAULT_PR_STATE_POLL_INTERVAL_MS)).toBe(true);
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

function makePostMergePoll(states: PRLifecycleState[]): {
  deps: Parameters<typeof pollPostMergeOutcome>[1];
  sleeps: number[];
  observed: () => number;
} {
  const sleeps: number[] = [];
  let observed = 0;
  let now = 0;
  return {
    deps: {
      observe: async () => {
        const state = states[Math.min(observed, states.length - 1)];
        observed += 1;
        return state === 'MERGED'
          ? { state, mergedAt: '2026-05-03T00:00:00Z' }
          : { state };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
    sleeps,
    observed: () => observed,
  };
}

function makePRStatePoll(
  states: PRLifecycleState[],
  initialNow = 0,
): {
  deps: Parameters<typeof pollPRState>[1];
  sleeps: number[];
  observed: () => number;
} {
  const sleeps: number[] = [];
  let observed = 0;
  let now = initialNow;
  return {
    deps: {
      observe: async () => {
        const state = states[Math.min(observed, states.length - 1)];
        observed += 1;
        return state === 'MERGED'
          ? { state, mergedAt: '2026-05-03T00:00:00Z' }
          : { state };
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      now: () => now,
    },
    sleeps,
    observed: () => observed,
  };
}
