/**
 * Role-specific codex activities for the refactor pipeline.
 *
 * Each role (planner / implementer / reviewer-correctness / reviewer-quality)
 * runs as its OWN Temporal Activity calling `codex exec` once with a focused
 * prompt. The workflow in `src/workflows/periodic.ts` orchestrates them — the
 * codex CLI does no internal subagent spawning. This gives:
 *   - Visibility: each role is one event in the Temporal UI.
 *   - Transparency: each prompt + result is logged separately by Temporal.
 *   - Reproducibility: workflow logic is deterministic; role activities are
 *     the only non-deterministic units, and they're independently retryable.
 *   - Token savings: no orchestrator-prompt overhead, each call is tight.
 *
 * Activity I/O is structured (parsed) rather than raw codex stdout — Temporal
 * serializes I/O into event history, so we keep payloads small and typed.
 */

import { ApplicationFailure, log } from '@temporalio/activity';
import { runCodexExec } from './codex';
import { PROMPTS } from './refactor-prompts';

export interface PlanStep {
  title: string;
  description: string;
  critical_requirements: string[];
}

export interface PlanOutput {
  theme: string;
  rationale: string;
  steps: PlanStep[];
}

export interface PlanInput {
  workdir: string;
  brief?: string;
  /** Optional override (default 5 min — within plan proxy's startToCloseTimeout). */
  timeoutMs?: number;
}

const PLAN_TIMEOUT_MS = 5 * 60 * 1000;

export async function planActivity(input: PlanInput): Promise<PlanOutput> {
  const prompt = PROMPTS.plan(input.brief);
  const res = await runCodexExec({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs ?? PLAN_TIMEOUT_MS,
  });
  return parsePlanOutput(res.lastMessage);
}

function parsePlanOutput(text: string): PlanOutput {
  const json = extractJsonObject(text);
  if (!json) {
    throw ApplicationFailure.create({
      message: 'planner did not return a parseable JSON object',
      type: 'PlannerOutputInvalid',
      nonRetryable: false,
      details: [text.slice(0, 2048)],
    });
  }
  const theme = typeof json.theme === 'string' ? json.theme : '';
  const rationale = typeof json.rationale === 'string' ? json.rationale : '';
  const steps = Array.isArray(json.steps)
    ? (json.steps as unknown[]).map(normalizeStep).filter((s): s is PlanStep => s !== undefined)
    : [];
  if (!theme) {
    throw ApplicationFailure.create({
      message: 'planner output missing required `theme` field',
      type: 'PlannerOutputInvalid',
      nonRetryable: false,
      details: [text.slice(0, 2048)],
    });
  }
  return { theme, rationale, steps };
}

function normalizeStep(raw: unknown): PlanStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title : '';
  const description = typeof r.description === 'string' ? r.description : '';
  const reqs = Array.isArray(r.critical_requirements)
    ? (r.critical_requirements as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (!title || !description || reqs.length === 0) return undefined;
  return { title, description, critical_requirements: reqs };
}

export interface ImplementInput {
  workdir: string;
  step: PlanStep;
  /** Reviewer feedback aggregated from prior iterations of this same step. */
  priorFeedback: string[];
  timeoutMs?: number;
}

export interface ImplementOutput {
  /** Markdown report from codex (truncated to fit Temporal payload limits). */
  report: string;
}

const IMPLEMENT_TIMEOUT_MS = 30 * 60 * 1000;
const REPORT_MAX_BYTES = 16 * 1024;

export async function implementActivity(input: ImplementInput): Promise<ImplementOutput> {
  const prompt = PROMPTS.implement(input.step, input.priorFeedback);
  const res = await runCodexExec({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs ?? IMPLEMENT_TIMEOUT_MS,
  });
  return { report: res.lastMessage.slice(0, REPORT_MAX_BYTES) };
}

export type ReviewConcern = 'correctness' | 'quality';

export interface ReviewInput {
  workdir: string;
  step: PlanStep;
  /** Diff text to feed the reviewer (already truncated by the workflow). */
  diff: string;
  concern: ReviewConcern;
  timeoutMs?: number;
}

export interface ReviewOutput {
  verdict: 'ok' | 'needs_revision' | 'critical_block';
  blocking_issues: string[];
  suggestions: string[];
}

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export async function reviewActivity(input: ReviewInput): Promise<ReviewOutput> {
  const prompt = PROMPTS.review(input.concern, input.step, input.diff);
  const res = await runCodexExec({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs ?? REVIEW_TIMEOUT_MS,
  });
  return parseReviewOutput(res.lastMessage, input.concern);
}

function parseReviewOutput(text: string, concern: ReviewConcern): ReviewOutput {
  const json = extractJsonObject(text);
  if (!json) {
    log.warn(`reviewer-${concern} produced unparseable output; pseudo-coercing to needs_revision`, {
      preview: text.slice(0, 200),
    });
    return {
      verdict: 'needs_revision',
      blocking_issues: [`reviewer-${concern} returned non-JSON: ${text.slice(0, 200)}`],
      suggestions: [],
    };
  }
  const verdict = ((): ReviewOutput['verdict'] => {
    const v = json.verdict;
    if (v === 'ok' || v === 'needs_revision' || v === 'critical_block') return v;
    return 'needs_revision';
  })();
  const blocking = Array.isArray(json.blocking_issues)
    ? (json.blocking_issues as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const suggestions = Array.isArray(json.suggestions)
    ? (json.suggestions as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { verdict, blocking_issues: blocking, suggestions };
}

/**
 * Pull the first `{...}` JSON object out of arbitrary model text. Tolerates a
 * preamble or markdown fences. Returns undefined on any parse failure.
 */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  // Fast path: whole text is JSON.
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to fenced/embedded extraction.
  }
  // Look for ```json ... ``` fence first (deterministic boundary).
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1].trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through.
    }
  }
  // Last resort: greedy match on first balanced-looking object.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}
