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

Output: EXACTLY one JSON object, nothing else.
Required fields:
- \`overview\`: 3-8 sentences describing what the repo does, primary language/framework, and top-level layout.
- \`conventions\`: 0-8 short strings describing testable invariants the next steps must respect.
- \`interfaces\`: 0-8 short strings describing stable signatures or shared types worth knowing.

Example JSON output:
{
  "overview": "This repository is a TypeScript service built around Temporal workflows. Source code lives under src and tests live under tests.",
  "conventions": ["Activities are pure functions", "Tests use Vitest"],
  "interfaces": ["Activity input and output values are JSON-serializable"]
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

Output: reply with EXACTLY one JSON object as the very first character of your reply. No prose, no markdown fences, no acknowledgments.
Required fields:
- \`theme\`: concise name for the refactor theme.
- \`rationale\`: why this theme is worth doing.
- \`steps\`: 1-2 step objects unless no worthwhile theme exists.
- Each step has \`title\`, \`description\`, and at least one \`critical_requirements\` string.
- Each step may include \`target_files\` with repo-relative paths the implementer is expected to modify.
- If no worthwhile theme exists, set \`theme\` to \`no-op\`, explain why in \`rationale\`, and return an empty \`steps\` array.

Example JSON output:
{
  "theme": "shared runner cleanup",
  "rationale": "The activities repeat Codex runner wiring, which makes timeout and parser behavior harder to keep consistent.",
  "steps": [
    {
      "title": "Extract shared runner helper",
      "description": "Route refactor role activities through one internal helper while preserving their existing behavior.",
      "critical_requirements": ["No public activity input or output types change"],
      "target_files": ["src/activities/refactor/_internal/run-role.ts"]
    }
  ]
}`;

// ──────────────────────────────────────────────────────────────────────────
// Implementer prompt
// ──────────────────────────────────────────────────────────────────────────

const IMPLEMENT_STATIC_BODY = `## Role: Implementer
You apply ONE step's edits to the working tree.

Hard rules (in addition to the global rules above):
- Edit the working tree only.
- Stay strictly inside the step's scope. Do not "while you're at it" drift to other improvements — those belong to a future step.
- If a \`## Files you may modify\` section appears below, treat those paths as a **hard scope constraint** — do not create or modify any file outside that list.
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
  example_blocking_issue: string;
  example_suggestion: string;
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
    example_blocking_issue: 'Step 1 requires a package install, which is not available in this environment.',
    example_suggestion: "Use the repository's existing test runner for verification.",
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
    example_blocking_issue: 'Step 1 combines prompt cleanup with unrelated activity timeout changes.',
    example_suggestion: 'Split unrelated changes into a separate step or keep this plan focused on prompt cleanup.',
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

Output: EXACTLY one JSON object, nothing else.
Required fields:
- \`verdict\`: \`ok\` or \`needs_revision\`.
- \`blocking_issues\`: concrete issues that should block implementation, or an empty array.
- \`suggestions\`: non-blocking improvements, or an empty array.

Example JSON output:
{
  "verdict": "needs_revision",
  "blocking_issues": ["${spec.example_blocking_issue}"],
  "suggestions": ["${spec.example_suggestion}"]
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

Output: EXACTLY one JSON object with the same shape as the planner output.
Required fields:
- \`theme\`: concise name for the refactor theme.
- \`rationale\`: why this theme is worth doing.
- \`steps\`: 1-2 step objects unless no worthwhile theme exists.
- Each step has \`title\`, \`description\`, and at least one \`critical_requirements\` string.
- Each step may include \`target_files\` with repo-relative paths the implementer is expected to modify.
- If no worthwhile theme exists, set \`theme\` to \`no-op\`, explain why in \`rationale\`, and return an empty \`steps\` array.

Example JSON output:
{
  "theme": "shared runner cleanup",
  "rationale": "The revised plan keeps the original theme while narrowing the implementation to one reviewable helper extraction.",
  "steps": [
    {
      "title": "Extract shared runner helper",
      "description": "Route refactor role activities through one internal helper while preserving their existing behavior.",
      "critical_requirements": ["No public activity input or output types change"],
      "target_files": ["src/activities/refactor/_internal/run-role.ts"]
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
  example_blocking_issue: string;
  example_suggestion: string;
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
    example_blocking_issue: 'The diff removes coverage for the parser error path without adding an equivalent test.',
    example_suggestion: 'Add a focused unit test for malformed JSON output.',
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
    example_blocking_issue: 'The new helper name hides that it mutates the plan before validation.',
    example_suggestion: 'Rename the helper to describe the mutation it performs.',
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

Output: EXACTLY one JSON object, nothing else.
Required fields:
- \`verdict\`: \`ok\`, \`needs_revision\`, or \`critical_block\`.
- \`blocking_issues\`: concrete issues for the implementer or workflow to address, or an empty array.
- \`suggestions\`: non-blocking improvements, or an empty array.

Example JSON output:
{
  "verdict": "needs_revision",
  "blocking_issues": ["${spec.example_blocking_issue}"],
  "suggestions": ["${spec.example_suggestion}"]
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
  const filesBlock =
    step.target_files && step.target_files.length > 0
      ? `\n## Files you may modify\n${step.target_files.map((f) => `- ${f}`).join('\n')}\n`
      : '';
  const dynamic = `## Dynamic input (this iteration)
### Step
\`\`\`json
${stepBlock}
\`\`\`
${filesBlock}
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
  context: CONTEXT_PROMPT,
  plan: PLAN_PROMPT,
  implement: IMPLEMENT_PROMPT,
  review: REVIEW_PROMPT,
  reviewPlan: REVIEW_PLAN_PROMPT,
  refinePlan: REFINE_PLAN_PROMPT,
};
