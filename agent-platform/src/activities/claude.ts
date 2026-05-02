import { ApplicationFailure } from '@temporalio/activity';
import { execCommand } from './_exec';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface RunClaudeInput {
  workdir: string;
  prompt: string;
  context?: string;
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  /** Restrict tool use; defaults to read+edit+bash for code modifications. */
  allowedTools?: string[];
}

export interface RunClaudeOutput {
  message: string;
  raw: string;
  changedFiles: string[];
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

async function ensureClaudeCredentials(): Promise<void> {
  const credPath = path.join(os.homedir(), '.claude', 'credentials');
  try {
    await fs.access(credPath);
  } catch {
    throw ApplicationFailure.nonRetryable(
      `~/.claude/credentials not found at ${credPath}; mount it as a Secret`,
      'MissingCredentials',
    );
  }
}

async function changedFilesIn(workdir: string): Promise<string[]> {
  const res = await execCommand('git', ['status', '--porcelain'], { cwd: workdir });
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

export async function runClaudeActivity(input: RunClaudeInput): Promise<RunClaudeOutput> {
  await ensureClaudeCredentials();

  const args = ['-p'];
  if (input.model) args.push('--model', input.model);
  if (input.allowedTools && input.allowedTools.length > 0) {
    args.push('--allowedTools', input.allowedTools.join(','));
  }
  // Always run non-interactive headless mode and accept tool use.
  args.push('--dangerously-skip-permissions');

  const fullPrompt = [
    input.systemPrompt?.trim(),
    input.context?.trim(),
    input.prompt.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await execCommand('claude', args, {
    cwd: input.workdir,
    input: fullPrompt,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      // Claude Code CLI honors HOME for credential path.
      HOME: process.env.HOME ?? os.homedir(),
      CLAUDE_NON_INTERACTIVE: '1',
    },
  });

  if (res.code !== 0) {
    throw ApplicationFailure.create({
      message: `claude exited ${res.code}: ${res.stderr.slice(0, 1024)}`,
      type: 'ClaudeInvocationError',
      details: [res.stdout.slice(0, 4096), res.stderr.slice(0, 4096)],
    });
  }

  const changed = await changedFilesIn(input.workdir);
  return {
    message: res.stdout.trim().slice(0, 16 * 1024),
    raw: res.stdout,
    changedFiles: changed,
  };
}
