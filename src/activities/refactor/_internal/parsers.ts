/**
 * JSON parsers for codex output across the refactor cluster.
 * Tolerant of preamble / markdown fences / trailing prose — codex sometimes
 * leaks filler text despite prompt-side hardening.
 */

import { ApplicationFailure, log } from '@temporalio/activity';
import { extractJsonObjectResult, extractStringArray } from '../../_internal/json-extract';
import { ERR_PLANNER_OUTPUT_INVALID } from '../../../errors';
import type { ContextArtifact, PlanOutput, PlanStep, PlanReviewConcern, PlanReviewOutput, ReviewConcern, ReviewOutput } from './types';

/**
 * Normalize an unknown JSON value to a known string union.
 * Returns `fallback` when the value is not in `valid`.
 */
function coerceVerdict<V extends string>(v: unknown, valid: readonly V[], fallback: V): V {
  return valid.includes(v as V) ? (v as V) : fallback;
}

export function parseContextOutput(text: string): Omit<ContextArtifact, 'generatedAt'> {
  const extracted = extractJsonObjectResult(text);
  if (!extracted.ok) {
    log.warn('context-extractor produced unparseable output; falling back to empty artifact', {
      preview: text.slice(0, 200),
      reason: extracted.message,
    });
    const overview =
      extracted.kind === 'malformed-json' || extracted.kind === 'non-object-json'
        ? `context-extractor returned invalid structured output: ${extracted.message}`
        : text.slice(0, 2000).trim();
    return { overview, conventions: [], interfaces: [] };
  }
  const json = extracted.value;
  const overview = typeof json.overview === 'string' ? json.overview : '';
  return {
    overview,
    conventions: extractStringArray(json.conventions),
    interfaces: extractStringArray(json.interfaces),
  };
}

export function parsePlanOutput(text: string): PlanOutput {
  const extracted = extractJsonObjectResult(text);
  if (!extracted.ok) {
    // PlannerOutputInvalid is in `NON_RETRYABLE` in proxies.ts: a deterministic
    // bad output won't be fixed by re-running the same prompt, so we let the
    // workflow's own catch-and-degrade path (`skipped: 'plan-failed'`) handle it.
    throw invalidPlanOutput(`planner did not return a parseable JSON object: ${extracted.message}`, text);
  }
  const json = extracted.value;
  const theme = typeof json.theme === 'string' ? json.theme : '';
  const rationale = typeof json.rationale === 'string' ? json.rationale : '';
  const steps = Array.isArray(json.steps)
    ? (json.steps as unknown[]).map(normalizeStep).filter((s): s is PlanStep => s !== undefined)
    : [];
  if (!theme) {
    throw invalidPlanOutput('planner output missing required `theme` field', text);
  }
  return { theme, rationale, steps };
}

function normalizeStep(raw: unknown): PlanStep | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title : '';
  const description = typeof r.description === 'string' ? r.description : '';
  const reqs = extractStringArray(r.critical_requirements);
  if (!title || !description || reqs.length === 0) return undefined;
  const target_files = Array.isArray(r.target_files) ? normalizeTargetFiles(r.target_files) : undefined;
  return { title, description, critical_requirements: reqs, ...(target_files !== undefined && { target_files }) };
}

function normalizeTargetFiles(raw: unknown[]): string[] | undefined {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const value of extractStringArray(raw)) {
    const file = value.trim();
    if (!isSafeRepoRelativePath(file) || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files.length > 0 ? files : undefined;
}

function isSafeRepoRelativePath(file: string): boolean {
  if (!file || /[\r\n]/.test(file)) return false;
  if (file.startsWith('/') || file.startsWith('\\')) return false;
  if (/^[A-Za-z]:[\\/]/.test(file)) return false;
  return !file.split(/[\\/]+/).includes('..');
}

const PLAN_REVIEW_VERDICTS = ['ok', 'needs_revision'] as const;
const REVIEW_VERDICTS = ['ok', 'needs_revision', 'critical_block'] as const;

/**
 * Shared fallback for reviewer parsers when structured output cannot be
 * extracted. Logs a warning, then returns the `blocking_issues`/`suggestions`
 * fields that every reviewer output shares; callers add their typed `verdict`.
 */
function parseFailFallback(
  label: string,
  text: string,
  message: string,
): { blocking_issues: string[]; suggestions: string[] } {
  log.warn(`${label} produced unparseable output; coercing to needs_revision`, {
    preview: text.slice(0, 200),
    reason: message,
  });
  return {
    blocking_issues: [`${label} returned invalid structured output: ${message}`],
    suggestions: [],
  };
}

export function parsePlanReviewOutput(text: string, concern: PlanReviewConcern): PlanReviewOutput {
  const extracted = extractJsonObjectResult(text);
  if (!extracted.ok) {
    return { verdict: 'needs_revision', ...parseFailFallback(`plan-reviewer-${concern}`, text, extracted.message) };
  }
  const json = extracted.value;
  return {
    verdict: coerceVerdict(json.verdict, PLAN_REVIEW_VERDICTS, 'needs_revision'),
    blocking_issues: extractStringArray(json.blocking_issues),
    suggestions: extractStringArray(json.suggestions),
  };
}

export function parseReviewOutput(text: string, concern: ReviewConcern): ReviewOutput {
  const extracted = extractJsonObjectResult(text);
  if (!extracted.ok) {
    return { verdict: 'needs_revision', ...parseFailFallback(`reviewer-${concern}`, text, extracted.message) };
  }
  const json = extracted.value;
  return {
    verdict: coerceVerdict(json.verdict, REVIEW_VERDICTS, 'needs_revision'),
    blocking_issues: extractStringArray(json.blocking_issues),
    suggestions: extractStringArray(json.suggestions),
  };
}

function invalidPlanOutput(message: string, text: string): ApplicationFailure {
  return ApplicationFailure.create({
    message,
    type: ERR_PLANNER_OUTPUT_INVALID,
    details: [text.slice(0, 2048)],
  });
}
