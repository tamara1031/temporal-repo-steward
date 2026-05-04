import { log } from '@temporalio/activity';
import { execOrThrow } from '../_internal/exec';
import {
  pollCIStatus,
  type PRWithChecks,
} from './_internal/wait-ci-poll';
import { ghEnv } from './_internal/gh-env';
import { invalidGhOutput, isRecord, parseGhJSON } from './_internal/gh-json';
import { parsePRLifecycleState } from './_internal/pr-state';
import { withGitHubWaitHeartbeat } from './_internal/wait-heartbeat';

export interface WaitForCIInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
  /**
   * Minimum continuous time (seconds) the rollup must remain "all done and
   * passing" with an unchanged signature before this activity returns
   * `success`. Guards against the GitHub registration race where a fast
   * check (e.g. lint) lands SUCCESS before sibling workflows have appeared
   * in `statusCheckRollup` at all. Default: 60 seconds. With the default
   * `pollIntervalSeconds` of 30, that's at least one full extra poll cycle
   * after the first all-done observation before the merge gate opens.
   */
  minSuccessStabilizationSeconds?: number;
}

/**
 * Terminal statuses observed by `waitForCIActivity`:
 *  - `success`: CI checks have settled with the same all-done-and-passing
 *    signature for at least `minSuccessStabilizationSeconds`. The
 *    stabilization window matters: GitHub registers workflows asynchronously,
 *    so a fast lint job can flash SUCCESS before its siblings have a
 *    check-suite entry — without the wait we'd treat that as the whole
 *    rollup and merge prematurely. Failures are NOT stabilized; the first
 *    fully-settled-with-failure observation returns immediately so self-heal
 *    can run on the next push.
 *  - `failure`: at least one check is done with a non-passing conclusion
 *    and no check is still pending.
 *  - `timeout`: hit `maxWaitSeconds` without a settled rollup.
 *  - `closed`: the PR was closed externally (human cancellation, base
 *    deleted, etc.). The workflow must exit cleanly — no self-heal applies.
 *  - `merged`: the PR was merged externally (e.g. base force-pushed, manual
 *    merge by a reviewer). Treat as a successful early exit.
 *
 * Caveat: stabilization gates *our* call to `gh pr merge --auto`, but once
 * `--auto` is requested GitHub itself merges as soon as branch-protection's
 * required-checks set passes. If the repo only marks a subset of workflows as
 * required, GitHub may merge while non-required checks are still running —
 * that is a branch-protection configuration choice, not something this
 * activity can override.
 */
export interface CIResult {
  status: 'success' | 'failure' | 'timeout' | 'closed' | 'merged';
  failedRunIds: string[];
  failedJobNames: string[];
}

export async function waitForCIActivity(input: WaitForCIInput): Promise<CIResult> {
  const env = ghEnv();

  return withGitHubWaitHeartbeat(
    { phase: 'wait-ci', prNumber: input.prNumber },
    async ({ sleep }) => {
      return pollCIStatus(input, {
        observe: async () => {
          const view = await execOrThrow(
            'gh',
            [
              'pr',
              'view',
              String(input.prNumber),
              '--repo',
              input.repoFullName,
              '--json',
              'statusCheckRollup,state',
            ],
            { env },
          );
          return parsePRWithChecksJSON(view.stdout);
        },
        sleep,
        now: Date.now,
        onExternallyClosed: () => {
          log.info('PR closed externally; exiting CI wait', { pr: input.prNumber });
        },
        onExternallyMerged: () => {
          log.info('PR merged externally; exiting CI wait', { pr: input.prNumber });
        },
        onNoChecksSettled: (stabilizationSeconds) => {
          log.info('No CI checks observed during stabilization window — treating as success', {
            pr: input.prNumber,
            stabilizationSeconds,
          });
        },
      });
    },
  );
}

/**
 * Parse `gh pr view --json statusCheckRollup,state`. We carry the rollup as
 * raw JSON forward into `parseStatusCheckRollupJSON` rather than decoding it
 * twice — keeps the existing helper as the single source of rollup truth.
 */
export function parsePRWithChecksJSON(stdout: string): PRWithChecks {
  const data = parseGhJSON(stdout, 'gh pr view --json statusCheckRollup,state');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json statusCheckRollup,state output must be a JSON object');
  }
  return {
    state: parsePRLifecycleState(data.state),
    checksJson: JSON.stringify({ statusCheckRollup: data.statusCheckRollup ?? [] }),
  };
}
