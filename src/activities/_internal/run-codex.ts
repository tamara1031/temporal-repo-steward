/**
 * Low-level `codex exec` runner shared by every codex activity.
 *
 * This is intentionally NOT a Temporal Activity itself — each role (planner /
 * implementer / reviewer / context extractor / generic single-shot) is its own
 * Activity so the Temporal UI shows one event per role and per-role retries /
 * timeouts are independent.
 *
 * Authentication: codex finds its credentials at `~/.codex/auth.json` (or
 * `$CODEX_HOME/auth.json`). On a Worker pod, mount the file produced by
 * `codex login` as a Secret. No OPENAI_API_KEY is required.
 */

import { ApplicationFailure } from '@temporalio/activity';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execCommand } from './exec';
import {
  ERR_MISSING_CREDENTIALS,
  ERR_RATE_LIMITED,
  ERR_CODEX_INVOCATION,
} from '../../errors';

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
      ERR_MISSING_CREDENTIALS,
    );
  }
}

/**
 * Run `codex exec` once with the given prompt. Returns the structured outputs
 * the calling role activity needs. The `--ask-for-approval never` and
 * `--sandbox danger-full-access` flags are not configurable here.
 *
 * Why `danger-full-access`: codex's other sandbox modes (`workspace-write` /
 * `read-only`) shell out to bubblewrap, which on K8s nodes requires
 * unprivileged user-namespace cloning. That depends on host kernel knobs
 * (`kernel.apparmor_restrict_unprivileged_userns`, AppArmor profiles,
 * seccomp) that we don't want to coordinate with the cluster operator.
 * Instead the Pod itself is the isolation boundary — it runs non-root,
 * with NetworkPolicy-restricted egress, an emptyDir workspace, and a
 * read-only auth.json mount. codex's own sandbox is redundant in that
 * setting.
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
    'danger-full-access',
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
      const stderrSnippet = res.stderr.slice(0, 1024);
      // Rate-limit / quota detection. Classified as `RateLimited` (retryable)
      // rather than the generic `CodexInvocationError` so the workflow proxy's
      // RetryPolicy can apply quota-friendly backoff.
      if (isRateLimit(res.stderr) || isRateLimit(res.stdout)) {
        throw ApplicationFailure.create({
          message: `codex hit a rate limit (exit ${res.code}): ${stderrSnippet}`,
          type: ERR_RATE_LIMITED,
          details: [res.stdout.slice(0, 2048), res.stderr.slice(0, 2048)],
        });
      }
      throw ApplicationFailure.create({
        message: `codex exited ${res.code}: ${stderrSnippet}`,
        type: ERR_CODEX_INVOCATION,
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

/**
 * Heuristic rate-limit detection on codex stderr / stdout. Codex CLI does not
 * expose a structured error for upstream LLM 429s — the message bubbles up as
 * free text. We match common phrasings: HTTP 429, "rate limit", "quota", and
 * the OpenAI-style "rate_limit_exceeded" code. False positives are tolerable
 * because `RateLimited` is still retryable; false negatives would treat a
 * 429 as `CodexInvocationError` which the proxy retries far less patiently.
 */
function isRateLimit(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('rate-limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota')
  );
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
