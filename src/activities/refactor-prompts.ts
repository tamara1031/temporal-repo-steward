/**
 * Role-specific prompt templates fed to `codex exec` by `refactor.ts`.
 *
 * Each prompt covers one role with a tight scope:
 *  - planner: pick ONE refactor theme, decompose into 1–2 steps with
 *    [critical] requirements. Read-only.
 *  - implementer: apply ONE step's edits to the working tree. Self-verify
 *    via available test/lint commands.
 *  - reviewer (parametric on `concern`): JSON verdict scoped to one concern
 *    bucket — `correctness` (security + DX/types/tests/errors) or `quality`
 *    (perf/cost + readability/cohesion/naming).
 *
 * Determinism note: pure string composition. Safe to call from anywhere
 * (tests, activities). Workflow code never imports this file directly.
 */

import type { PlanStep, ReviewConcern } from './refactor';

const PLAN_PROMPT = `You are the **Planner**. Identify ONE high-cohesion refactor theme and decompose it into **1 or 2** independently-implementable steps. You must NOT modify any files.

Process:
1. Read the README, the package manifest (package.json / go.mod / pyproject.toml etc.), and the most central modules. Stop reading once you have a theme — do not survey the entire tree.
2. Identify ONE theme that delivers real value. Reject "miscellaneous improvements" — high cohesion within the theme is mandatory.
3. Decompose into **1 or 2** steps (prefer 1; only split when the work genuinely cannot land as one reviewable unit). More steps multiply downstream cost.
4. For each step, define **at least one** \`critical_requirement\`: a testable success condition tied to system behavior (examples: "all existing unit tests still pass", "no public API surface change", "lint emits zero new warnings", "function X returns identical output for given input").

Hard rules:
- No file edits. No network calls (curl / wget / npm install / etc.). No git, no gh, no push.
- Stay terse. The plan is a contract, not an essay.

Output: reply with EXACTLY one JSON object and NOTHING else (no prose, no markdown fences). Schema:
{
  "theme": string,
  "rationale": string,
  "steps": [
    {
      "title": string,
      "description": string,
      "critical_requirements": [string, ...]
    }
  ]
}

If no worthwhile theme exists (repo too small, already optimal, blocked by environment), return:
{ "theme": "no-op", "rationale": "<why>", "steps": [] }
`;

const IMPLEMENT_PROMPT = (step: PlanStep, priorFeedback: string[]): string => {
  const stepBlock = JSON.stringify(step, null, 2);
  const feedbackBlock =
    priorFeedback.length === 0
      ? ''
      : `\nPrior reviewer feedback to address (from earlier iterations on this same step):\n${priorFeedback.map((f) => `- ${f}`).join('\n')}\n`;
  return `You are the **Implementer**. Apply ONE step's edits to the working tree.

Step:
\`\`\`json
${stepBlock}
\`\`\`
${feedbackBlock}
Hard rules:
- Edit the working tree only.
- Do **NOT** run any of: \`git commit\`, \`git push\`, \`git fetch\`, \`git merge\`, \`git stash\`, \`gh\`. The host workflow owns those operations.
- Stay strictly inside the step's scope. Do not "while you're at it" drift to other improvements — those belong to a future step.
- Run available test/lint commands to self-verify before reporting (\`npm test\`, \`npm run lint\`, \`tsc --noEmit\`, etc.). Brief retry on flake is fine; do not paper over real failures.
- If you cannot satisfy a \`critical_requirement\`, say so explicitly. Do not silently weaken or paraphrase it.

Output: reply with a concise markdown report (the workflow stores this verbatim):

## Changed files
- bullet list of paths

## Verification
- command name → pass / fail / not-applicable (one-line reason)

## Critical requirements
- requirement → met / not-met (one-line evidence)

## Notes
- anything reviewers should focus on, including any **discretionary fill-ins** (decisions you made beyond the step description)
`;
};

interface ConcernSpec {
  label: string;
  checklist: string[];
  critical_examples: string;
  out_of_scope_reminder: string;
}

const CONCERN_SPECS: Record<ReviewConcern, ConcernSpec> = {
  correctness: {
    label: 'correctness — security + DX (type safety / tests / error handling)',
    checklist: [
      'Credential / secret exposure (logs, error messages, committed content, tests)',
      'Command injection / shell-quoting bugs / unsafe deserialization / SSRF / path traversal',
      'Authn / authz bypass; broken trust boundaries',
      'New dependencies — provenance, supply-chain risk, known CVEs',
      'Type safety regressions (`any`, `unknown`, casts widening)',
      'Tests removed or weakened with no replacement',
      'Error messages that won\'t help future debuggers; silent failure modes / swallowed exceptions',
      'Behavior changes not reflected in tests or docs',
    ],
    critical_examples:
      '(credential leak, injection, auth bypass, broken trust boundary, public API made strictly worse, tests removed without replacement)',
    out_of_scope_reminder:
      "Do not comment on style, naming, performance, or cost — that is the `quality` reviewer's territory.",
  },
  quality: {
    label: 'quality — performance/cost + readability/naming/cohesion',
    checklist: [
      'Algorithmic regressions (e.g. O(n²) where O(n) was easy and obvious)',
      'Sync / blocking I/O on hot paths; missing parallelism (sequential awaits where Promise.all is natural)',
      'Unnecessary allocations or copies in tight loops',
      'Cost-relevant: superfluous network calls, missing caching where natural, retry storms, unbounded memory growth',
      'Names that lie or hide intent',
      'Functions doing more than one thing; cohesion violations (unrelated changes within one step)',
      'Unnecessary cleverness; missing-or-wrong abstraction',
      'Comments that explain WHAT instead of WHY (or contradict the code)',
      'Dead code, leftover scaffolding, TODOs without owner',
    ],
    critical_examples:
      '(severe regression on a hot path, runaway-cost risk, or a diff so unclear it is actively misleading future readers — use sparingly)',
    out_of_scope_reminder:
      "Do not comment on security, type safety, tests, or error handling — that is the `correctness` reviewer's territory.",
  },
};

const REVIEW_PROMPT = (concern: ReviewConcern, step: PlanStep, diff: string): string => {
  const spec = CONCERN_SPECS[concern];
  const stepBlock = JSON.stringify(step, null, 2);
  return `You are a **Parliament Member** with concern: **${spec.label}**.

Step:
\`\`\`json
${stepBlock}
\`\`\`

Diff under review (truncated to fit your context):
\`\`\`diff
${diff}
\`\`\`

Hard rules:
- Do **NOT** modify any files. Read-only. (The workflow audits drift via post-hoc \`git status --porcelain\` and reverts any reviewer edits.)
- ${spec.out_of_scope_reminder}
- Be terse. One bullet per concrete issue.

Concern checklist:
${spec.checklist.map((c) => `- ${c}`).join('\n')}

Output: reply with EXACTLY one JSON object and NOTHING else (no prose, no markdown fences). Schema:
{
  "verdict": "ok" | "needs_revision" | "critical_block",
  "blocking_issues": [string, ...],
  "suggestions": [string, ...]
}

Verdict semantics:
- \`critical_block\`: a genuine showstopper ${spec.critical_examples}. Triggers a full rollback of the entire refactor pass.
- \`needs_revision\`: non-blocking but real concerns the implementer should address before merge.
- \`ok\`: nothing of concern from the ${concern} angle for this diff.
`;
};

export const PROMPTS = {
  plan: (brief?: string): string => {
    const trimmed = brief?.trim();
    if (!trimmed) return PLAN_PROMPT;
    return `${PLAN_PROMPT}\nAdditional brief from the operator:\n${trimmed}\n`;
  },
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
};
