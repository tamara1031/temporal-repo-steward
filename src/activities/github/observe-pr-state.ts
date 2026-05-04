import { ghEnv } from './_internal/gh-env';
import {
  observePRState,
  parsePRStateJSON as parsePRStateJSONInternal,
  type PRLifecycleState as InternalPRLifecycleState,
} from './_internal/pr-state';

export type PRLifecycleState = InternalPRLifecycleState;

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
  return observePRState(input.repoFullName, input.prNumber, env);
}

export function parsePRStateJSON(stdout: string): ObservePRStateOutput {
  return parsePRStateJSONInternal(stdout);
}
