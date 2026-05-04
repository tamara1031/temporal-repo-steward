import { execOrThrow } from '../../_internal/exec';
import { invalidGhOutput, isRecord, parseGhJSON } from './gh-json';

export type PRLifecycleState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PRStateObservation {
  state: PRLifecycleState;
  /** ISO-8601 string when GitHub records `mergedAt`; undefined while OPEN/CLOSED. */
  mergedAt?: string;
}

export function prStateViewArgs(repoFullName: string, prNumber: number): string[] {
  return ['pr', 'view', String(prNumber), '--repo', repoFullName, '--json', 'state,mergedAt'];
}

export async function observePRState(
  repoFullName: string,
  prNumber: number,
  env: NodeJS.ProcessEnv,
): Promise<PRStateObservation> {
  const res = await execOrThrow('gh', prStateViewArgs(repoFullName, prNumber), { env });
  return parsePRStateJSON(res.stdout);
}

export function parsePRStateJSON(stdout: string): PRStateObservation {
  const data = parseGhJSON(stdout, 'gh pr view --json state,mergedAt');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json state,mergedAt output must be a JSON object');
  }
  const state = parsePRLifecycleState(data.state);
  const mergedAtRaw = data.mergedAt;
  if (mergedAtRaw !== undefined && mergedAtRaw !== null && typeof mergedAtRaw !== 'string') {
    throw invalidGhOutput('gh pr view returned non-string mergedAt');
  }
  return {
    state,
    ...(typeof mergedAtRaw === 'string' && mergedAtRaw.length > 0 ? { mergedAt: mergedAtRaw } : {}),
  };
}

export function parsePRLifecycleState(stateRaw: unknown): PRLifecycleState {
  if (stateRaw !== 'OPEN' && stateRaw !== 'CLOSED' && stateRaw !== 'MERGED') {
    throw invalidGhOutput(
      `gh pr view returned unexpected state ${JSON.stringify(stateRaw)}; expected OPEN|CLOSED|MERGED`,
    );
  }
  return stateRaw;
}
