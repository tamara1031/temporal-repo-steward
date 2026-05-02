import { ApplicationFailure } from '@temporalio/activity';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execCommand } from './exec';

export interface CodexInput {
  workdir: string;
  prompt: string;
  /** Optional system-level instruction prepended to the prompt. */
  systemPrompt?: string;
  /** Optional supporting context (logs, diffs, prior analysis) prepended to the prompt. */
  context?: string;
  /** Files to focus on. Appended to the prompt as a hint; codex still has full repo access. */
  paths?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface CodexOutput {
  /** Trimmed stdout from codex (truncated to 16 KiB). */
  message: string;
  /** Full raw stdout. */
  raw: string;
  /** Files codex modified, derived from `git status --porcelain`. */
  changedFiles: string[];
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Path to the auth file produced by `codex login` (browser-based ChatGPT login).
 * Override with `CODEX_HOME` to point at a different directory.
 */
function codexAuthPath(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

async function ensureCodexAuth(): Promise<void> {
  const p = codexAuthPath();
  try {
    await fs.access(p);
  } catch {
    throw ApplicationFailure.nonRetryable(
      `codex auth not found at ${p}; run \`codex login\` locally and mount the resulting auth.json`,
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

/**
 * Runs `codex exec` against the working tree at `workdir`.
 *
 * - If the prompt asks codex to inspect only, no files are modified and
 *   `changedFiles` is empty — i.e. this doubles as an analysis activity.
 * - If the prompt asks codex to edit, modifications land in the working tree
 *   and `changedFiles` lists them. Commit / push happens in the workflow.
 *
 * Authentication: codex finds its credentials at `~/.codex/auth.json` (or
 * `$CODEX_HOME/auth.json`). On a Worker pod, mount the file produced by
 * `codex login` as a Secret. No OPENAI_API_KEY is required.
 */
export async function codexActivity(input: CodexInput): Promise<CodexOutput> {
  await ensureCodexAuth();

  // The Worker container is itself the security boundary, so we let codex run
  // shell tools without bubblewrap (which otherwise fails with
  // `bwrap: No permissions to create a new namespace` inside Docker).
  const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
  if (input.model) args.push('--model', input.model);

  const parts = [input.systemPrompt?.trim(), input.context?.trim(), input.prompt.trim()]
    .filter(Boolean) as string[];
  if (input.paths && input.paths.length > 0) {
    parts.push('Focus on these paths:\n' + input.paths.map((p) => ` - ${p}`).join('\n'));
  }
  const fullPrompt = parts.join('\n\n');

  const res = await execCommand('codex', args, {
    cwd: input.workdir,
    input: fullPrompt,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: {
      // Codex CLI honors HOME (and CODEX_HOME) to locate auth.json.
      HOME: process.env.HOME ?? os.homedir(),
      ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
      CODEX_NON_INTERACTIVE: '1',
      // Defense-in-depth: the prompt forbids `git push` / `gh`, but with sandbox
      // bypassed we also strip GitHub credentials from codex's child shell so a
      // disobedient model cannot exfiltrate or push with them.
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
  });

  if (res.code !== 0) {
    throw ApplicationFailure.create({
      message: `codex exited ${res.code}: ${res.stderr.slice(0, 1024)}`,
      type: 'CodexInvocationError',
      details: [res.stdout.slice(0, 4096), res.stderr.slice(0, 4096)],
    });
  }

  const changedFiles = await changedFilesIn(input.workdir);
  return {
    message: res.stdout.trim().slice(0, 16 * 1024),
    raw: res.stdout,
    changedFiles,
  };
}
