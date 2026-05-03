/**
 * Role-specific prompt templates fed to `codex exec` by `refactor.ts`.
 *
 * Layout principle — **static-first / dynamic-last** for prompt-cache hits:
 *   Every role's prompt opens with a frozen block (role identity, hard rules,
 *   output schema, the workflow-wide ContextArtifact) that is identical across
 *   sibling activities within a single workflow run. The trailing section
 *   carries per-call dynamic data (step JSON, prior feedback, diff text).
 *   LLM provider prompt caches key on prefix, so this layout maximizes hits
 *   across plan / implement / review activities.
 *
 * Each prompt covers one role with a tight scope:
 *  - context: extract a small ContextArtifact (overview / conventions /
 *    interfaces) from the working tree at workflow init. JSON output.
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

import type { ContextArtifact, PlanOutput, PlanReviewConcern, PlanStep, ReviewConcern } from './types';

// ──────────────────────────────────────────────────────────────────────────
// Static-preamble helpers (identical bytes across plan/implement/review for
// a given workflow run → cacheable prefix).
// ──────────────────────────────────────────────────────────────────────────

const STATIC_HARD_RULES = `Global hard rules (apply to every codex invocation in this pipeline):
- Never run \`git commit\`, \`git push\`, \`git fetch\`, \`git merge\`, \`git stash\`, or \`gh\`. The host Temporal workflow owns those operations.
- No network calls (curl / wget / npm install / pip install / etc.).
- No filler / acknowledgments in your final reply. Output ONLY the artifact requested by your role section. Do not write conversational lines like "I'll review this", "Looks good", "Thanks for the diff", or summary lines that restate what you just did.`;

/**
 * Render the context artifact body.
 *
 * `generatedAt` is intentionally omitted: LLMs don't need the timestamp for
 * refactoring decisions, and omitting it from prompts avoids spending tokens on
 * metadata that is only useful for audit/logs (where the field is still
 * accessible on the `ContextArtifact` struct).
 */
function renderContextArtifact(ctx: ContextArtifact): string {
  const conventions =
    ctx.conventions.length === 0
      ? '- (none recorded)'
      : ctx.conventions.map((c) => `- ${c}`).join('\n');
  const interfaces =
    ctx.interfaces.length === 0 ? '- (none recorded)' : ctx.interfaces.map((i) => `- ${i}`).join('\n');
  return `## Repository Context Artifact (workflow-wide, frozen)

### Overview
${ctx.overview || '(no overview captured)'}

### Coding conventions / invariants
${conventions}

### Stable interfaces / shared types
${interfaces}`;
}

/** Cacheable preamble shared by plan / implement / review. */
function staticPreamble(ctx: ContextArtifact): string {
  return `${STATIC_HARD_RULES}

${renderContextArtifact(ctx)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Context-extractor prompt (no ContextArtifact — this IS what generates it).
// ──────────────────────────────────────────────────────────────────────────

const CONTEXT_PROMPT = `You are the **Context Extractor**. You run ONCE at the start of the workflow to distill a small, durable summary of the repository for downstream roles. Read the README, the package manifest (package.json / go.mod / pyproject.toml / Cargo.toml etc.), and 2–4 of the most central modules. Stop reading once you have enough — do not survey the entire tree.

Hard rules:
- Read-only. Do not modify any files.
- No network calls. No git, no gh.
- **No filler.** Do not write "I'll summarize this", "Here's the overview", "Sure, let me extract", or any acknowledgment line. The very first character of your reply MUST be \`{\`. No markdown fences.

Output JSON schema:
{
  "overview": string,        // 3–8 sentences: what the repo does, primary language/framework, top-level layout
  "conventions": [string,...],  // testable invariants the next steps must respect (e.g. "all activities are pure functions", "no top-level side effects in src/", "tests live alongside source as *.test.ts"). 0–8 bullets.
  "interfaces": [string,...]    // stable signatures or shared types worth knowing (e.g. "Activity I/O is JSON-serializable", "exports from src/activities/index.ts are the worker-registered surface"). 0–8 bullets.
}

Keep each bullet under ~20 words. The artifact is reused across every subsequent codex call this run, so concision matters more than completeness.`;

// ──────────────────────────────────────────────────────────────────────────
// Planner prompt
// ──────────────────────────────────────────────────────────────────────────

const PLAN_STATIC_BODY = `## Role: Planner
You identify ONE high-cohesion refactor theme and decompose it into **1 or 2** independently-implementable steps. You must NOT modify any files.

Process:
1. Use the Context Artifact above as your primary repo summary. Read additional files only when the artifact is insufficient.
2. Identify ONE theme that delivers real value. Reject "miscellaneous improvements" — high cohesion within the theme is mandatory.
3. Decompose into **1 or 2** steps (prefer 1; only split when the work genuinely cannot land as one reviewable unit). More steps multiply downstream cost.
4. For each step, define **at least one** \`critical_requirement\`: a testable success condition tied to system behavior (examples: "all existing unit tests still pass", "no public API surface change", "lint emits zero new warnings", "function X returns identical output for given input").

Output: reply with EXACTLY one JSON object as the very first character of your reply. No prose, no markdown fences, no acknowledgments. Schema:
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
{ "theme": "no-op", "rationale": "<why>", "steps": [] }`;

// ──────────────────────────────────────────────────────────────────────────
// Implementer prompt
// ──────────────────────────────────────────────────────────────────────────

const IMPLEMENT_STATIC_BODY = `## Role: Implementer
You apply ONE step's edits to the working tree.

Hard rules (in addition to the global rules above):
- Edit the working tree only.
- Stay strictly inside the step's scope. Do not "while you're at it" drift to other improvements — those belong to a future step.
- Run available test/lint commands to self-verify before reporting (\`npm test\`, \`npm run lint\`, \`tsc --noEmit\`, etc.). Brief retry on flake is fine; do not paper over real failures.
- If you cannot satisfy a \`critical_requirement\`, say so explicitly. Do not silently weaken or paraphrase it.

Output: reply with a concise markdown report (the workflow stores this verbatim). Do not preface or summarize.

## Changed files
- bullet list of paths

## Verification
- command name → pass / fail / not-applicable (one-line reason)

## Critical requirements
- requirement → met / not-met (one-line evidence)

## Notes
- anything reviewers should focus on, including any **discretionary fill-ins** (decisions you made beyond the step description)`;

// ──────────────────────────────────────────────────────────────────────────
// Plan reviewer prompt (parametric on PlanReviewConcern)
// ──────────────────────────────────────────────────────────────────────────

interface PlanConcernSpec {
  label: string;
  checklist: string[];
  out_of_scope_reminder: string;
}

const PLAN_CONCERN_SPECS: Record<PlanReviewConcern, PlanConcernSpec> = {
  feasibility: {
    label: 'feasibility — whether the plan can be executed in this environment',
    checklist: [
      'Each step only modifies the working tree; no network access (npm install, curl, etc.) required to implement it',
      'Files/modules/APIs referenced in descriptions are plausible given the ContextArtifact',
      'Each `critical_requirement` can be verified with commands available in the repo (npm test, tsc --noEmit, lint scripts, etc.)',
      'Steps are scoped realistically for one implementer session — not so broad they would require multiple large refactors',
      'No step implicitly depends on output from a future step (ordering is feasible as written)',
    ],
    out_of_scope_reminder:
      "Do not comment on naming quality, cohesion, or decomposition style — that is the `scope` reviewer's territory.",
  },
  scope: {
    label: 'scope — theme cohesion and step decomposition quality',
    checklist: [
      'Steps form a coherent, high-cohesion theme — not a grab-bag of unrelated improvements',
      'Each step is independently reviewable (could land as a standalone diff)',
      'Descriptions are specific enough to guide an implementer without ambiguity',
      'Decomposition is appropriate: not so fine-grained steps are trivial, nor so coarse one step conflates multiple distinct changes',
      '`rationale` explains the value delivered, not just restates the theme',
      'The theme is not "no-op" masquerading as a real improvement',
    ],
    out_of_scope_reminder:
      "Do not comment on feasibility, environment constraints, or whether commands exist — that is the `feasibility` reviewer's territory.",
  },
};

function planReviewerStaticBody(concern: PlanReviewConcern): string {
  const spec = PLAN_CONCERN_SPECS[concern];
  return `## Role: Design Parliament Member (concern = ${spec.label})

Hard rules (in addition to the global rules above):
- **READ-ONLY.** Do not modify any files.
- ${spec.out_of_scope_reminder}
- **No filler.** Do not write "I'll review this", "Looks good", or any acknowledgment. The very first character of your reply MUST be \`{\`.
- One bullet per concrete issue. Do not pad with restatements of the plan.

Concern checklist (your scope, exhaustively):
${spec.checklist.map((c) => `- ${c}`).join('\n')}

Output: EXACTLY one JSON object, nothing else. Schema:
{
  "verdict": "ok" | "needs_revision",
  "blocking_issues": [string, ...],
  "suggestions": [string, ...]
}

Verdict semantics:
- \`needs_revision\`: real issues that should be addressed before implementation begins.
- \`ok\`: the plan looks sound from the ${concern} angle.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Plan refiner prompt
// ──────────────────────────────────────────────────────────────────────────

const REFINE_PLAN_STATIC_BODY = `## Role: Plan Refiner
You receive a refactor plan and consolidated feedback from design reviewers. Produce an improved plan.

Hard rules (in addition to the global rules above):
- Read-only. Do not modify any files.
- Address every item listed under **blocking issues** in the feedback.
- Do NOT change the theme unless the feedback explicitly identifies the theme as wrong or infeasible.
- Preserve steps that received no criticism; only revise or split steps that were flagged.
- **No filler.** The very first character of your reply MUST be \`{\`. No markdown fences.

Output: EXACTLY one JSON object with the same schema as the planner:
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
}`;

// ──────────────────────────────────────────────────────────────────────────
// Reviewer prompt (parametric on concern)
// ──────────────────────────────────────────────────────────────────────────

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

function reviewerStaticBody(concern: ReviewConcern): string {
  const spec = CONCERN_SPECS[concern];
  return `## Role: Parliament Member (concern = ${spec.label})

Hard rules (in addition to the global rules above):
- **READ-ONLY.** Do NOT modify any files. The workflow runs \`git status --porcelain\` after you and reverts any drift you introduce.
- ${spec.out_of_scope_reminder}
- **No filler.** Do not write "I'll review this", "Looks good", "Here's my analysis", or summary lines. The very first character of your reply MUST be \`{\`.
- One bullet per concrete issue. Do not pad with restatements of the diff.

Concern checklist (your scope, exhaustively):
${spec.checklist.map((c) => `- ${c}`).join('\n')}

Output: EXACTLY one JSON object, nothing else. Schema:
{
  "verdict": "ok" | "needs_revision" | "critical_block",
  "blocking_issues": [string, ...],
  "suggestions": [string, ...]
}

Verdict semantics:
- \`critical_block\`: a genuine showstopper ${spec.critical_examples}. Triggers a full rollback of the entire refactor pass.
- \`needs_revision\`: non-blocking but real concerns the implementer should address before merge.
- \`ok\`: nothing of concern from the ${concern} angle for this diff.`;
}

// ──────────────────────────────────────────────────────────────────────────
// Composers — static preamble (cacheable) ‖ role-static body ‖ dynamic tail
// ──────────────────────────────────────────────────────────────────────────

function compose(ctx: ContextArtifact, roleBody: string, dynamicTail: string): string {
  return `${staticPreamble(ctx)}

${roleBody}

${dynamicTail}`;
}

const PLAN_PROMPT = (ctx: ContextArtifact, brief?: string): string => {
  const dynamic = brief?.trim()
    ? `## Dynamic input (this run)
Operator brief: ${brief.trim()}`
    : `## Dynamic input (this run)
(no operator brief)`;
  return compose(ctx, PLAN_STATIC_BODY, dynamic);
};

const IMPLEMENT_PROMPT = (
  ctx: ContextArtifact,
  step: PlanStep,
  priorFeedback: string[],
): string => {
  const stepBlock = JSON.stringify(step, null, 2);
  const feedbackBlock =
    priorFeedback.length === 0
      ? '(none — this is the first iteration on this step)'
      : priorFeedback.map((f) => `- ${f}`).join('\n');
  const dynamic = `## Dynamic input (this iteration)
### Step
\`\`\`json
${stepBlock}
\`\`\`

### Prior reviewer feedback to address
${feedbackBlock}`;
  return compose(ctx, IMPLEMENT_STATIC_BODY, dynamic);
};

const REVIEW_PROMPT = (
  ctx: ContextArtifact,
  concern: ReviewConcern,
  step: PlanStep,
  diff: string,
): string => {
  const stepBlock = JSON.stringify(step, null, 2);
  const dynamic = `## Dynamic input (this iteration)
### Step
\`\`\`json
${stepBlock}
\`\`\`

### Diff under review (truncated to fit context)
\`\`\`diff
${diff}
\`\`\``;
  return compose(ctx, reviewerStaticBody(concern), dynamic);
};

const REVIEW_PLAN_PROMPT = (ctx: ContextArtifact, concern: PlanReviewConcern, plan: PlanOutput): string => {
  const planBlock = JSON.stringify(plan, null, 2);
  const dynamic = `## Dynamic input (this round)
### Plan under review
\`\`\`json
${planBlock}
\`\`\``;
  return compose(ctx, planReviewerStaticBody(concern), dynamic);
};

const REFINE_PLAN_PROMPT = (
  ctx: ContextArtifact,
  plan: PlanOutput,
  feedback: string[],
): string => {
  const planBlock = JSON.stringify(plan, null, 2);
  const feedbackBlock =
    feedback.length === 0
      ? '(no feedback — accept plan as-is)'
      : feedback.map((f) => `- ${f}`).join('\n');
  const dynamic = `## Dynamic input (this round)
### Current plan
\`\`\`json
${planBlock}
\`\`\`

### Reviewer feedback to address
${feedbackBlock}`;
  return compose(ctx, REFINE_PLAN_STATIC_BODY, dynamic);
};

export const PROMPTS = {
  context: (): string => CONTEXT_PROMPT,
  plan: PLAN_PROMPT,
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  reviewPlan: REVIEW_PLAN_PROMPT,
  refinePlan: REFINE_PLAN_PROMPT,
};
