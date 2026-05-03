/**
 * JSON parsers for codex output across the refactor cluster.
 * Tolerant of preamble / markdown fences / trailing prose — codex sometimes
 * leaks filler text despite prompt-side hardening.
 */

import { ApplicationFailure, log } from '@temporalio/activity';
import { extractJsonObject } from '../../_internal/json-extract';
import { ERR_PLANNER_OUTPUT_INVALID } from '../../../errors';
import type { ContextArtifact, PlanOutput, PlanStep, PlanReviewConcern, PlanReviewOutput, ReviewConcern, ReviewOutput } from './types';

export function parseContextOutput(text: string): Omit<ContextArtifact, 'generatedAt'> {
  const json = extractJsonObject(text);
  if (!json) {
    log.warn('context-extractor produced unparseable output; falling back to empty artifact', {
      preview: text.slice(0, 200),
    });
    return { overview: text.slice(0, 2000).trim(), conventions: [], interfaces: [] };
  }
  const overview = typeof json.overview === 'string' ? json.overview : '';
  const conventions = Array.isArray(json.conventions)
    ? (json.conventions as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const interfaces = Array.isArray(json.interfaces)
    ? (json.interfaces as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { overview, conventions, interfaces };
}

export function parsePlanOutput(text: string): PlanOutput {
  const json = extractJsonObject(text);
  if (!json) {
    // PlannerOutputInvalid is in `NON_RETRYABLE` in proxies.ts: a deterministic
    // bad output won't be fixed by re-running the same prompt, so we let the
    // workflow's own catch-and-degrade path (`skipped: 'plan-failed'`) handle it.
    throw ApplicationFailure.create({
      message: 'planner did not return a parseable JSON object',
      type: ERR_PLANNER_OUTPUT_INVALID,
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
      type: ERR_PLANNER_OUTPUT_INVALID,
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
  const target_files = Array.isArray(r.target_files)
    ? (r.target_files as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;
  return { title, description, critical_requirements: reqs, ...(target_files !== undefined && { target_files }) };
}

export function parsePlanReviewOutput(text: string, concern: PlanReviewConcern): PlanReviewOutput {
  const json = extractJsonObject(text);
  if (!json) {
    log.warn(`plan-reviewer-${concern} produced unparseable output; coercing to needs_revision`, {
      preview: text.slice(0, 200),
    });
    return {
      verdict: 'needs_revision',
      blocking_issues: [`plan-reviewer-${concern} returned non-JSON: ${text.slice(0, 200)}`],
      suggestions: [],
    };
  }
  const verdict = ((): PlanReviewOutput['verdict'] => {
    const v = json.verdict;
    if (v === 'ok' || v === 'needs_revision') return v;
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

export function parseReviewOutput(text: string, concern: ReviewConcern): ReviewOutput {
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
