import { runRefactorCodex } from './_internal/codex-runner';
import { parsePlanReviewOutput } from './_internal/parsers';
import { PROMPTS } from './_internal/prompts';
import type { ContextArtifact, PlanOutput, PlanReviewConcern, PlanReviewOutput } from './_internal/types';

export interface ReviewPlanInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  plan: PlanOutput;
  concern: PlanReviewConcern;
  timeoutMs?: number;
}

const REVIEW_PLAN_TIMEOUT_MS = 5 * 60 * 1000;

export async function reviewPlanActivity(input: ReviewPlanInput): Promise<PlanReviewOutput> {
  const prompt = PROMPTS.reviewPlan(input.contextArtifact, input.concern, input.plan);
  const res = await runRefactorCodex({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: REVIEW_PLAN_TIMEOUT_MS,
  });
  return parsePlanReviewOutput(res.lastMessage, input.concern);
}
