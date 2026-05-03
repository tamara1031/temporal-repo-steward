import { ApplicationFailure } from '@temporalio/activity';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execCommand } from './exec';

/**
 * Low-level `codex exec` runner shared by every role-specific activity in
 * `refactor.ts`. This is intentionally NOT a Temporal Activity itself — each
 * role (planner / implementer / reviewer) is its own Activity so the Temporal
 * UI shows one event per role and per-role retries / timeouts are independent.
 *
 * Authentication: codex finds its credentials at `~/.codex/auth.json` (or
 * `$CODEX_HOME/auth.json`). On a Worker pod, mount the file produced by
 * `codex login` as a Secret. No OPENAI_API_KEY is required.
 */

export interface CodexRunInput {
  workdir: string;
  /** The full prompt fed to `codex exec` on stdin. */
  prompt: string;
  /** Per-role timeout. The workflow proxy's startToCloseTimeout is the outer bound. */
  timeoutMs: number;
  /** Optional model override (otherwise uses codex's default). */
  model?: string;
}

export interface CodexRunOutput {
  /** Final reply captured via `--output-last-message` (preferred for parsing). */
  lastMessage: string;
  /** Combined stdout (kept for diagnostics — do NOT propagate through workflow state). */
  stdoutForLog: string;
}

const DEFAULT_BACKSTOP_TIMEOUT_MS = 30 * 60 * 1000;

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

/**
 * Run `codex exec` once with the given prompt. Returns the structured outputs
 * the calling role activity needs. The `--ask-for-approval never` and
 * `--sandbox workspace-write` flags are not configurable here — they are the
 * security envelope codex runs under in this system.
 */
export async function runCodexExec(input: CodexRunInput): Promise<CodexRunOutput> {
  await ensureCodexAuth();

  const lastMsgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-last-msg-'));
  const lastMsgPath = path.join(lastMsgDir, 'final.md');
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--sandbox',
    'workspace-write',
    '--output-last-message',
    lastMsgPath,
  ];
  if (input.model) args.push('--model', input.model);

  try {
    const res = await execCommand('codex', args, {
      cwd: input.workdir,
      input: input.prompt,
      timeoutMs: input.timeoutMs ?? DEFAULT_BACKSTOP_TIMEOUT_MS,
      env: {
        HOME: process.env.HOME ?? os.homedir(),
        ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        CODEX_NON_INTERACTIVE: '1',
        // Defense-in-depth: even though we don't ask codex to push, strip GitHub
        // creds from its child shell so a disobedient model can't exfiltrate.
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

    const last = await readLastMessage(lastMsgPath);
    return {
      lastMessage: (last ?? res.stdout).trim(),
      stdoutForLog: res.stdout,
    };
  } finally {
    await fs.rm(lastMsgDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readLastMessage(p: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(p, 'utf8');
    const trimmed = buf.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// `codexActivity` — generic single-shot codex Activity used outside the
// refactor pipeline (CI self-heal, merge-conflict resolution in pr-lifecycle).
// The refactor pipeline uses the role-specific activities in `refactor.ts`
// for visibility; this one is for ad-hoc "run codex on the working tree once"
// scenarios where decomposition adds no value.
// ──────────────────────────────────────────────────────────────────────────

export interface CodexInput {
  workdir: string;
  prompt: string;
  /** Optional system-level instruction prepended to the prompt. */
  systemPrompt?: string;
  /** Optional supporting context (logs, diffs) prepended to the prompt. */
  context?: string;
  /** Files to focus on. Appended as a hint; codex still has full repo access. */
  paths?: string[];
  model?: string;
  timeoutMs?: number;
}

export interface CodexOutput {
  /** Trimmed last message (truncated to 16 KiB). */
  message: string;
  /** Files codex modified, derived from `git status --porcelain`. */
  changedFiles: string[];
}

const GENERIC_DEFAULT_TIMEOUT_MS = 80 * 60 * 1000;

export async function codexActivity(input: CodexInput): Promise<CodexOutput> {
  const parts = [input.systemPrompt?.trim(), input.context?.trim(), input.prompt.trim()].filter(
    Boolean,
  ) as string[];
  if (input.paths && input.paths.length > 0) {
    parts.push('Focus on these paths:\n' + input.paths.map((p) => ` - ${p}`).join('\n'));
  }
  const fullPrompt = parts.join('\n\n');

  const out = await runCodexExec({
    workdir: input.workdir,
    prompt: fullPrompt,
    timeoutMs: input.timeoutMs ?? GENERIC_DEFAULT_TIMEOUT_MS,
    model: input.model,
  });
  const changedFiles = await changedFilesIn(input.workdir);
  return {
    message: out.lastMessage.slice(0, 16 * 1024),
    changedFiles,
  };
}

async function changedFilesIn(workdir: string): Promise<string[]> {
  const res = await execCommand('git', ['status', '--porcelain'], { cwd: workdir });
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}
