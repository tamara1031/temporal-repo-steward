import { ApplicationFailure } from '@temporalio/activity';
import { execCommand } from './_exec';

export interface CodexAnalyzeInput {
  workdir: string;
  prompt: string;
  paths?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface CodexAnalyzeOutput {
  summary: string;
  raw: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export async function codexAnalyzeActivity(
  input: CodexAnalyzeInput,
): Promise<CodexAnalyzeOutput> {
  // `codex exec` is the non-interactive subcommand of @openai/codex.
  // Adjust flags here if your codex version expects different syntax.
  const args = ['exec'];
  if (input.model) {
    args.push('--model', input.model);
  }
  // Pass paths as part of the prompt body — codex exec reads stdin too.
  let promptBody = input.prompt;
  if (input.paths && input.paths.length > 0) {
    promptBody += '\n\nFocus on these paths:\n' + input.paths.map((p) => ` - ${p}`).join('\n');
  }

  const res = await execCommand('codex', args, {
    cwd: input.workdir,
    input: promptBody,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      CODEX_NON_INTERACTIVE: '1',
    },
  });

  if (res.code !== 0) {
    // Treat as retryable application failure so Temporal's retry policy
    // gets to back off and try again.
    throw ApplicationFailure.create({
      message: `codex exited ${res.code}: ${res.stderr.slice(0, 1024)}`,
      type: 'CodexInvocationError',
      details: [res.stdout.slice(0, 4096), res.stderr.slice(0, 4096)],
    });
  }

  return {
    summary: res.stdout.trim(),
    raw: res.stdout,
  };
}

export interface CodexConflictDigestInput {
  workdir: string;
  conflictedFiles: string[];
  diffSummary: string;
  timeoutMs?: number;
}

export async function codexConflictDigestActivity(
  input: CodexConflictDigestInput,
): Promise<CodexAnalyzeOutput> {
  const prompt =
    'Summarize the merge conflicts in this repository. For each conflicted file, describe the ' +
    'two competing intents and propose a unified resolution that preserves both behaviors when ' +
    'possible. Output a structured plan that another tool can execute.\n\nConflicted files:\n' +
    input.conflictedFiles.map((f) => ` - ${f}`).join('\n') +
    '\n\nDiff summary:\n' +
    input.diffSummary;
  return codexAnalyzeActivity({
    workdir: input.workdir,
    prompt,
    paths: input.conflictedFiles,
    timeoutMs: input.timeoutMs,
  });
}
