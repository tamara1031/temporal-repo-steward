import { log, sleep, workflowInfo, ApplicationFailure } from '@temporalio/workflow';
import { advisor, cheap, heavy, heavyCodex, ciWait } from './proxies';
import type {
  AdvisorVerdict,
  CheckConflictOutput,
  CIResult,
  PRInfo,
} from '../activities';

export interface RobustPRMergeInput {
  repoFullName: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  prTitle: string;
  prBody: string;
  /** Hard cap on CI-fail / conflict iterations to prevent infinite loops. */
  maxFixIterations?: number;
  /** When false, run CI / self-heal but stop before merging. Defaults to true. */
  autoMerge?: boolean;
  /**
   * Hard cap on advisor (top-model) consultations within this workflow run.
   * Each consult costs more tokens than a regular codex call, so we keep this
   * tight. Default 2: one for "should I keep self-healing?" and one reserve.
   */
  maxAdvisorConsults?: number;
  /**
   * Override for the post-merge poll interval (ms). Production uses the
   * 10-second default; tests inject a smaller value to keep wall time low.
   */
  postMergePollIntervalMs?: number;
  /** Override for the post-merge poll attempt count. Tests can lower this. */
  postMergePollAttempts?: number;
}

export interface RobustPRMergeOutput {
  prNumber: number;
  prUrl: string;
  iterations: number;
  /**
   * True only when the workflow has *observed* the PR enter the MERGED state.
   * `gh pr merge --auto` queues the merge — the workflow polls afterwards to
   * convert "merge requested" into "merge confirmed".
   */
  merged: boolean;
  /**
   * Distinguishes the terminal state for the operator:
   *  - `merged`: actually landed (mergedAt observed).
   *  - `merge-queued`: gh accepted `--auto`; merge has not yet landed within
   *    the post-merge poll window (e.g. waiting on required-up-to-date).
   *  - `auto-merge-disabled`: caller asked to stop before merging.
   *  - `closed-externally` / `merged-externally`: the PR was closed or merged
   *    by something other than this workflow during the CI loop.
   */
  outcome:
    | 'merged'
    | 'merge-queued'
    | 'auto-merge-disabled'
    | 'closed-externally'
    | 'merged-externally';
  /** Number of advisor consults actually performed. */
  advisorConsults: number;
}

const POST_MERGE_POLL_ATTEMPTS = 6;
const POST_MERGE_POLL_INTERVAL_MS = 10_000;
const CI_POLL_INTERVAL_SECONDS = 30;
const CI_MAX_WAIT_SECONDS = 60 * 60;

/**
 * Common PR lifecycle, robust against external interference (merges from
 * other PRs, human cancellation, codex producing no diff):
 *   1. Push branch + open PR.
 *   2. CI loop — on failure: pull failed logs, codex fix, push, retry.
 *      Optionally consult an Advisor before iter ≥ 2 to bail on structural
 *      failures rather than burning the iteration budget.
 *   3. Conflict loop — on conflict: codex resolve, push, return to CI loop.
 *   4. Merge: request via `gh pr merge --auto`, then poll until the PR is
 *      observed in MERGED state (or report `merge-queued` if it doesn't land
 *      promptly — typical when branch protection requires up-to-date).
 *   5. PR observed CLOSED / MERGED externally (e.g. another PR merged first
 *      and the human resolved by closing this one) — short-circuit out of
 *      the loop without throwing.
 */
export async function robustPRMergeWorkflow(
  input: RobustPRMergeInput,
): Promise<RobustPRMergeOutput> {
  const maxIters = input.maxFixIterations ?? 8;
  const autoMerge = input.autoMerge ?? true;
  const advisorBudget = new AdvisorBudget(input.maxAdvisorConsults ?? 2);
  const info = workflowInfo();

  await heavy.pushBranchActivity({
    workdir: input.workdir,
    branch: input.branch,
    setUpstream: true,
  });

  const pr: PRInfo = await cheap.createPRActivity({
    repoFullName: input.repoFullName,
    workdir: input.workdir,
    branch: input.branch,
    baseBranch: input.baseBranch,
    title: input.prTitle,
    body: input.prBody,
    draft: false,
  });
  log.info('Opened PR', { pr: pr.url, workflowId: info.workflowId });

  let iter = 0;
  while (iter < maxIters) {
    const ci = await waitForCI(pr.number, input.repoFullName);

    const externalExit = handleExternalExit(ci, pr, advisorBudget);
    if (externalExit) return externalExit;

    if (ci.status === 'failure') {
      iter += 1;
      const advice = await maybeConsultBeforeSelfHeal({
        iter,
        ci,
        input,
        advisorBudget,
      });
      if (advice === 'abort') {
        throw ApplicationFailure.create({
          message: `Advisor recommended abort after CI iter ${iter} on PR #${pr.number}`,
          type: 'AdvisorAbort',
        });
      }

      await runCISelfHeal({ iter, ci, input, advisorBudget });
      continue;
    }

    const conflict = await cheap.checkConflictActivity({
      workdir: input.workdir,
      baseBranch: input.baseBranch,
    });

    if (conflict.hasConflict) {
      iter += 1;
      await runConflictResolve({
        iter,
        conflict,
        input,
        advisorBudget,
      });
      continue;
    }

    if (!autoMerge) {
      log.info('autoMerge=false; skipping merge', { pr: pr.url, workflowId: info.workflowId });
      return {
        prNumber: pr.number,
        prUrl: pr.url,
        iterations: iter,
        merged: false,
        outcome: 'auto-merge-disabled',
        advisorConsults: advisorBudget.used(),
      };
    }

    await cheap.mergePRActivity({
      repoFullName: input.repoFullName,
      prNumber: pr.number,
      mergeMethod: 'squash',
      deleteBranch: true,
    });

    const observed = await pollUntilMerged(
      input.repoFullName,
      pr.number,
      input.postMergePollAttempts ?? POST_MERGE_POLL_ATTEMPTS,
      input.postMergePollIntervalMs ?? POST_MERGE_POLL_INTERVAL_MS,
    );
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      iterations: iter,
      merged: observed === 'merged',
      outcome: observed,
      advisorConsults: advisorBudget.used(),
    };
  }

  throw ApplicationFailure.create({
    message: `PR #${pr.number} exceeded max self-heal iterations (${maxIters})`,
    type: 'MaxIterationsExceeded',
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Step helpers — extracted so the main loop reads as a sequence of intents.
// All helpers are pure orchestration over Activity calls.
// ──────────────────────────────────────────────────────────────────────────

async function waitForCI(prNumber: number, repoFullName: string): Promise<CIResult> {
  return ciWait.waitForCIActivity({
    repoFullName,
    prNumber,
    pollIntervalSeconds: CI_POLL_INTERVAL_SECONDS,
    maxWaitSeconds: CI_MAX_WAIT_SECONDS,
  });
}

/**
 * If CI returns one of the externally-driven terminal states (`closed`,
 * `merged`, `timeout`), translate that into a workflow outcome — either an
 * early successful return or a thrown failure. Returns undefined when the
 * workflow should keep going (success / failure cases).
 */
function handleExternalExit(
  ci: CIResult,
  pr: PRInfo,
  advisorBudget: AdvisorBudget,
): RobustPRMergeOutput | undefined {
  if (ci.status === 'timeout') {
    throw ApplicationFailure.create({
      message: `CI did not converge within timeout for PR #${pr.number}`,
      type: 'CITimeout',
    });
  }
  if (ci.status === 'closed') {
    log.info('PR was closed externally; abandoning workflow', { pr: pr.url });
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      iterations: 0,
      merged: false,
      outcome: 'closed-externally',
      advisorConsults: advisorBudget.used(),
    };
  }
  if (ci.status === 'merged') {
    log.info('PR was merged externally; treating as success', { pr: pr.url });
    return {
      prNumber: pr.number,
      prUrl: pr.url,
      iterations: 0,
      merged: true,
      outcome: 'merged-externally',
      advisorConsults: advisorBudget.used(),
    };
  }
  return undefined;
}

interface SelfHealContext {
  iter: number;
  /** Always called with `ci.status === 'failure'` — typed as the full union to keep call sites simple. */
  ci: CIResult;
  input: RobustPRMergeInput;
  advisorBudget: AdvisorBudget;
}

/**
 * Optionally consults the advisor BEFORE attempting another self-heal.
 * Triggers only when:
 *   - we're entering iter ≥ 2 (the first attempt deserves to run; the second
 *     is when "is this even fixable?" becomes worth asking), AND
 *   - the advisor budget has remaining capacity.
 *
 * Returns `'continue'` to proceed with self-heal, `'abort'` to stop, or
 * `'change-strategy'` to also proceed (the workflow doesn't have a third
 * branch yet — we surface the suggested action in logs and PR body, then
 * fall through to the normal self-heal). The verdict gating is intentionally
 * simple to keep the workflow's call graph small.
 */
async function maybeConsultBeforeSelfHeal(
  ctx: SelfHealContext,
): Promise<'continue' | 'abort' | 'change-strategy'> {
  if (ctx.iter < 2) return 'continue';
  if (!ctx.advisorBudget.canConsume()) {
    log.info('advisor budget exhausted; proceeding with self-heal', { iter: ctx.iter });
    return 'continue';
  }
  ctx.advisorBudget.consume();

  const summary = [
    `Failed jobs: ${ctx.ci.failedJobNames.slice(0, 6).join(', ') || '(none reported)'}`,
    `Failed run IDs: ${ctx.ci.failedRunIds.slice(0, 6).join(', ') || '(none)'}`,
    `Self-heal iteration about to start: ${ctx.iter}/${ctx.input.maxFixIterations ?? 8}`,
  ].join('\n');

  let verdict: AdvisorVerdict;
  let rationale = '';
  let suggestedAction: string | undefined;
  try {
    const reply = await advisor.consultAdvisorActivity({
      workdir: ctx.input.workdir,
      situation: `CI is red on PR #${ctx.input.branch}; deciding whether to attempt self-heal again.`,
      summary,
      options: [
        'retry — pattern looks transient or fixable with one more codex pass',
        'abort — failure is structural; stop and surface to a human',
        'change-strategy — try a different prompt or convert PR to draft for human review',
      ],
    });
    verdict = reply.verdict;
    rationale = reply.rationale;
    suggestedAction = reply.suggestedAction;
  } catch (err) {
    log.warn('advisor consult failed; defaulting to continue', { err: String(err) });
    return 'continue';
  }
  log.info('advisor verdict before self-heal', {
    iter: ctx.iter,
    verdict,
    rationale,
    suggestedAction,
  });
  return verdict === 'abort' ? 'abort' : 'continue';
}

async function runCISelfHeal(ctx: SelfHealContext): Promise<void> {
  const failedLogs = await collectFailedLogs(ctx.input.repoFullName, ctx.ci.failedRunIds);
  log.warn('CI failed; entering self-heal cycle', {
    iter: ctx.iter,
    failedRunIds: ctx.ci.failedRunIds,
  });
  const fix = await heavyCodex.codexActivity({
    workdir: ctx.input.workdir,
    systemPrompt:
      'You are an autonomous fix-it engineer. Identify the failing test/build from ' +
      'the CI logs and apply MINIMAL changes to make CI pass. ' +
      'Do not add unrelated improvements.',
    context: 'CI logs:\n' + failedLogs.slice(0, 64 * 1024),
    prompt: 'Apply the minimal fix to the working tree, then stop.',
  });
  await commitAndPushOrEscalate({
    iter: ctx.iter,
    input: ctx.input,
    advisorBudget: ctx.advisorBudget,
    commitMessage: `fix(ci): self-heal attempt ${ctx.iter}`,
    codexMessage: fix.message,
  });
}

interface ConflictResolveContext {
  iter: number;
  conflict: CheckConflictOutput;
  input: RobustPRMergeInput;
  advisorBudget: AdvisorBudget;
}

async function runConflictResolve(ctx: ConflictResolveContext): Promise<void> {
  log.warn('Merge conflict detected; entering resolve cycle', {
    iter: ctx.iter,
    files: ctx.conflict.conflictedFiles,
  });
  const resolve = await heavyCodex.codexActivity({
    workdir: ctx.input.workdir,
    systemPrompt:
      'You resolve git merge conflicts. Preserve intent from both sides whenever possible. ' +
      'Leave NO conflict markers in the resulting files.',
    context: 'Conflict diff:\n' + (ctx.conflict.diffSummary ?? ''),
    paths: ctx.conflict.conflictedFiles,
    prompt:
      'Resolve all merge conflicts in the working tree. ' +
      `Conflicted files: ${ctx.conflict.conflictedFiles.join(', ')}.`,
  });
  await commitAndPushOrEscalate({
    iter: ctx.iter,
    input: ctx.input,
    advisorBudget: ctx.advisorBudget,
    commitMessage: `chore(merge): resolve conflicts attempt ${ctx.iter}`,
    codexMessage: resolve.message,
  });
}

interface CommitAndPushContext {
  iter: number;
  input: RobustPRMergeInput;
  advisorBudget: AdvisorBudget;
  commitMessage: string;
  codexMessage: string;
}

/**
 * Commit the codex-applied fix and push it. When codex produces no diff at
 * all we optionally consult the advisor (if budget permits) for a logged
 * second opinion, then throw `NoFixDiff` — the advisor's verdict is recorded
 * for the operator but does not change the throw, because by then no fix
 * exists to push.
 */
async function commitAndPushOrEscalate(ctx: CommitAndPushContext): Promise<void> {
  const commit = await heavy.commitAllActivity({
    workdir: ctx.input.workdir,
    message: ctx.commitMessage,
  });

  if (!commit.committed) {
    await escalateNoDiff(ctx);
    return;
  }

  await heavy.pushBranchActivity({
    workdir: ctx.input.workdir,
    branch: ctx.input.branch,
  });
}

async function escalateNoDiff(ctx: CommitAndPushContext): Promise<never> {
  if (ctx.advisorBudget.canConsume()) {
    ctx.advisorBudget.consume();
    try {
      const reply = await advisor.consultAdvisorActivity({
        workdir: ctx.input.workdir,
        situation: 'codex reported success but produced no diff during self-heal',
        summary:
          `Iter ${ctx.iter}. Codex final message (truncated):\n` +
          ctx.codexMessage.slice(0, 1024),
        options: [
          'abort — codex misunderstands the failure; stop and request human review',
          'change-strategy — close PR and re-open with a different prompt next run',
        ],
      });
      log.warn('advisor on no-diff', {
        verdict: reply.verdict,
        rationale: reply.rationale,
        suggestedAction: reply.suggestedAction,
      });
    } catch (err) {
      log.warn('advisor consult on no-diff failed', { err: String(err) });
    }
  }
  throw ApplicationFailure.create({
    message: 'Codex reported success but produced no diff; cannot self-heal',
    type: 'NoFixDiff',
    details: [ctx.codexMessage.slice(0, 4096)],
  });
}

async function collectFailedLogs(
  repoFullName: string,
  failedRunIds: readonly string[],
): Promise<string> {
  const parts: string[] = [];
  for (const runId of failedRunIds.slice(0, 3)) {
    const part = await cheap.fetchFailedRunLogsActivity({ repoFullName, runId });
    parts.push(`### Run ${runId}\n${part}`);
  }
  return parts.join('\n\n');
}

/**
 * Poll for the actual merge to land. `gh pr merge --auto` only requests the
 * merge — when branch-protection requires "up to date", the merge can sit in
 * a queue. We poll a small number of times; if the PR has not entered MERGED
 * by then we report `merge-queued` rather than lying about success.
 */
async function pollUntilMerged(
  repoFullName: string,
  prNumber: number,
  attempts: number,
  intervalMs: number,
): Promise<'merged' | 'merge-queued'> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const observed = await cheap.observePRStateActivity({ repoFullName, prNumber });
    if (observed.state === 'MERGED') {
      log.info('PR merge observed', { prNumber, mergedAt: observed.mergedAt });
      return 'merged';
    }
    if (observed.state === 'CLOSED') {
      // gh accepted --auto, but the PR is now closed without merging. Surface
      // the surprise rather than report success.
      throw ApplicationFailure.create({
        message: `PR #${prNumber} was closed without merging after merge request was issued`,
        type: 'MergeAbandoned',
      });
    }
    await sleep(intervalMs);
  }
  log.info('PR still queued after merge request; reporting merge-queued', { prNumber });
  return 'merge-queued';
}

// ──────────────────────────────────────────────────────────────────────────
// Workflow-side state — pure, deterministic, safe in workflow code.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hard cap on how many advisor (top-model) consults a single workflow run
 * may make. The advisor is intentionally rare; if every retry triggered one
 * the cost would balloon. The counter is workflow-local so it is naturally
 * deterministic across replays.
 */
class AdvisorBudget {
  private consumed = 0;
  constructor(private readonly cap: number) {}
  canConsume(): boolean {
    return this.consumed < this.cap;
  }
  consume(): void {
    this.consumed += 1;
  }
  used(): number {
    return this.consumed;
  }
}

