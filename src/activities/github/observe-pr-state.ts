import { execOrThrow } from '../_internal/exec';
import { ghEnv } from './_internal/gh-env';
import { invalidGhOutput, isRecord, parseGhJSON } from './_internal/gh-json';

export type PRLifecycleState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface ObservePRStateInput {
  repoFullName: string;
  prNumber: number;
}

export interface ObservePRStateOutput {
  state: PRLifecycleState;
  /** ISO-8601 string when GitHub records `mergedAt`; undefined while OPEN/CLOSED. */
  mergedAt?: string;
}

/**
 * Single-shot observation of a PR's lifecycle state. Used by the workflow
 * after `gh pr merge --auto` to distinguish "merge has actually landed" from
 * "merge is queued behind required-up-to-date". The workflow loops over this
 * activity with its own timer; the activity itself does NOT poll, so it stays
 * cheap and idempotent.
 */
export async function observePRStateActivity(
  input: ObservePRStateInput,
): Promise<ObservePRStateOutput> {
  const env = ghEnv();
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
}

export function parsePRStateJSON(stdout: string): ObservePRStateOutput {
  const data = parseGhJSON(stdout, 'gh pr view --json state,mergedAt');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json state,mergedAt output must be a JSON object');
  }
  const stateRaw = data.state;
  if (stateRaw !== 'OPEN' && stateRaw !== 'CLOSED' && stateRaw !== 'MERGED') {
    throw invalidGhOutput(
      `gh pr view returned unexpected state ${JSON.stringify(stateRaw)}; expected OPEN|CLOSED|MERGED`,
    );
  }
  const mergedAtRaw = data.mergedAt;
  if (mergedAtRaw !== undefined && mergedAtRaw !== null && typeof mergedAtRaw !== 'string') {
    throw invalidGhOutput('gh pr view returned non-string mergedAt');
  }
  return {
    state: stateRaw,
    ...(typeof mergedAtRaw === 'string' && mergedAtRaw.length > 0 ? { mergedAt: mergedAtRaw } : {}),
  };
}
