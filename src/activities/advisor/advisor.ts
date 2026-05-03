/**
 * `consultAdvisorActivity` — single-shot escalation to a stronger model when
 * the workflow is stuck or about to take a costly / destructive action.
 *
 * Design constraints (deliberately tight):
 *  - **Single hop.** The caller hands over an already-condensed summary
 *    (~2 KiB max). The advisor does NOT read logs or diffs itself; that is
 *    the agent's job upstream. This keeps tokens bounded.
 *  - **Structured JSON verdict.** One of `retry / abort / change-strategy`,
 *    plus a short rationale. Parsed with the same tolerant extractor used
 *    elsewhere so a stray preamble doesn't sink the call.
 *  - **Observe-only by convention.** The advisor must not mutate the
 *    working tree. Enforced by prompt instruction only — codex runs with
 *    `--sandbox danger-full-access` system-wide (see run-codex.ts) so the
 *    Pod boundary, not codex's sandbox, is the isolation guarantee.
 *  - **Workflow-side budget.** The workflow owns an `AdvisorBudget`
 *    counter — the activity itself does not police call frequency.
 *
 * Model selection: `ADVISOR_MODEL` env var on the Worker (e.g. a stronger
 * codex-supported model). Unset → codex picks its default. The activity is
 * tolerant of either; we trade model quality for cost knobs without
 * conditioning the rest of the system on a specific name.
 */

import { ApplicationFailure } from '@temporalio/activity';
import { runCodexExec } from '../_internal/run-codex';
import { extractJsonObject } from '../refactor/_internal/parsers';

export type AdvisorVerdict = 'retry' | 'abort' | 'change-strategy';

export interface ConsultAdvisorInput {
  /**
   * Working tree path. Read-only for the advisor; passed through so codex's
   * tool environment is consistent. The advisor MAY peek at files when the
   * agent's summary is ambiguous, but should not need to.
   */
  workdir: string;
  /** One-line description of where the workflow is stuck. */
  situation: string;
  /**
   * Compact summary the advisor reasons over. Hard-capped at
   * `MAX_INPUT_BYTES`; the caller is responsible for distilling logs / diffs.
   */
  summary: string;
  /**
   * Concrete options the workflow is choosing between. Listed in the prompt
   * so the verdict maps cleanly onto a workflow branch.
   */
  options?: string[];
  /** Optional model override (otherwise reads `ADVISOR_MODEL` from env). */
  model?: string;
}

export interface ConsultAdvisorOutput {
  verdict: AdvisorVerdict;
  /** ≤ 280 chars — surfaces in workflow logs & PR body. */
  rationale: string;
  /** Free-form short suggestion mapped onto the chosen verdict. ≤ 280 chars. */
  suggestedAction?: string;
}

const MAX_INPUT_BYTES = 2 * 1024;
const MAX_RATIONALE_CHARS = 280;
const ADVISOR_TIMEOUT_MS = 3 * 60 * 1000;

const ADVISOR_PROMPT_PREAMBLE = `You are an **Advisor**. The autonomous agent you advise has hit a decision gate and consults you sparingly. Reply with EXACTLY one JSON object as the very first character of your reply. No prose, no markdown fences, no acknowledgments.

Hard rules:
- You are READ-ONLY. Do not modify any files. The workflow trusts you to honor this — there is no sandbox enforcing it.
- No filler. No "I'll review this", "Looks good", or summary lines.
- Keep \`rationale\` under 280 characters. Be terse and concrete.
- Pick exactly one verdict that matches the agent's situation. Do not invent new verdicts.

Output schema:
{
  "verdict": "retry" | "abort" | "change-strategy",
  "rationale": string,
  "suggested_action": string  // optional, ≤ 280 chars
}

Verdict semantics:
- \`retry\`: the same approach is plausibly fine; one more attempt is justified (e.g. transient flake, marginal misunderstanding).
- \`abort\`: the path is structurally wrong; further attempts will not converge. Stop and surface the failure.
- \`change-strategy\`: a different tactic may succeed. Put the *concrete* alternative in \`suggested_action\` (e.g. "skip the failing step", "open the PR as draft for human review").`;

export async function consultAdvisorActivity(
  input: ConsultAdvisorInput,
): Promise<ConsultAdvisorOutput> {
  const summary = clip(input.summary ?? '', MAX_INPUT_BYTES);
  const situation = clip(input.situation ?? '', 280);
  const options = (input.options ?? []).slice(0, 6).map((o) => clip(o, 200));

  const optionsBlock =
    options.length === 0
      ? '(no candidate options listed — pick from {retry, abort, change-strategy})'
      : options.map((o, i) => `${i + 1}. ${o}`).join('\n');

  const prompt = `${ADVISOR_PROMPT_PREAMBLE}

## Situation
${situation || '(no situation provided)'}

## Summary (agent-condensed)
${summary || '(no summary provided)'}

## Candidate options the agent is considering
${optionsBlock}`;

  const res = await runCodexExec({
    workdir: input.workdir,
    prompt,
    timeoutMs: ADVISOR_TIMEOUT_MS,
    model: input.model ?? process.env.ADVISOR_MODEL,
  });

  const json = extractJsonObject(res.lastMessage);
  if (!json) {
    throw ApplicationFailure.create({
      message: 'advisor returned non-JSON output',
      type: 'AdvisorOutputInvalid',
      details: [res.lastMessage.slice(0, 1024)],
    });
  }

  const verdict = normalizeVerdict(json.verdict);
  const rationale = clip(typeof json.rationale === 'string' ? json.rationale : '', MAX_RATIONALE_CHARS);
  const suggestedRaw =
    typeof json.suggested_action === 'string'
      ? json.suggested_action
      : typeof json.suggestedAction === 'string'
        ? json.suggestedAction
        : '';
  const suggestedAction = suggestedRaw ? clip(suggestedRaw, MAX_RATIONALE_CHARS) : undefined;

  return { verdict, rationale, ...(suggestedAction ? { suggestedAction } : {}) };
}

function normalizeVerdict(raw: unknown): AdvisorVerdict {
  if (raw === 'retry' || raw === 'abort' || raw === 'change-strategy') return raw;
  if (raw === 'change_strategy') return 'change-strategy';
  // Treat unrecognized verdicts as `abort` — failing safe. The rationale will
  // expose the surprise so a human can decide whether to lift the cap.
  return 'abort';
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
