import { Context, log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import { ghEnv, sleepCancellable } from './_internal/gh-env';
import { pollPostMergeOutcome, type PostMergeOutcome } from './_internal/post-merge-poll';
import { parsePRStateJSON } from './observe-pr-state';

export interface WaitForPostMergeInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export type { PostMergeOutcome } from './_internal/post-merge-poll';
export { mapPostMergeStateToOutcome } from './_internal/post-merge-poll';

/**
 * Poll after `gh pr merge --auto` has accepted the merge request. This is an
 * Activity rather than workflow-side polling so the wait can heartbeat and
 * receive cancellation through Temporal's activity cancellation path.
 */
export async function waitForPostMergeActivity(
  input: WaitForPostMergeInput,
): Promise<PostMergeOutcome> {
  const env = ghEnv();
  const ctx = Context.current();

  const outcome = await pollPostMergeOutcome(
    {
      prNumber: input.prNumber,
      pollIntervalMs: input.pollIntervalMs,
      maxPollAttempts: input.maxPollAttempts,
    },
    {
      observe: async () => {
        const res = await execOrThrow(
          'gh',
          [
            'pr',
            'view',
            String(input.prNumber),
            '--repo',
            input.repoFullName,
            '--json',
            'state,mergedAt',
          ],
          { env },
        );
        return parsePRStateJSON(res.stdout);
      },
      heartbeat: (details) => ctx.heartbeat(details),
      sleep: (ms) => sleepCancellable(ms, ctx.cancellationSignal),
      now: () => Date.now(),
      onTerminalOutcome: (outcome, observed) => {
        if (outcome === 'merged') {
          log.info('PR merge observed', { prNumber: input.prNumber, mergedAt: observed.mergedAt });
        } else {
          log.info('PR closed externally during post-merge poll', { prNumber: input.prNumber });
        }
      },
    },
  );
  if (outcome === 'merge-queued') {
    log.info('PR still queued after merge request; reporting merge-queued', {
      prNumber: input.prNumber,
    });
  }
  return outcome;
}
