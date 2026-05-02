import { ApplicationFailure } from '@temporalio/activity';

export function parseGhJSON(stdout: string, commandDescription: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw invalidGhOutput(`${commandDescription} returned malformed JSON: ${message}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function invalidGhOutput(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, 'InvalidGitHubOutput');
}
