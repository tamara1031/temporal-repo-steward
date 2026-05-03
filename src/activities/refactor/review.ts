import { runRefactorCodex } from './_internal/codex-runner';
import { parseReviewOutput } from './_internal/parsers';
import { PROMPTS } from './_internal/prompts';
import type {
  ContextArtifact,
  PlanStep,
  ReviewConcern,
  ReviewOutput,
} from './_internal/types';

export interface ReviewInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  step: PlanStep;
  /** Diff text to feed the reviewer (already truncated by the workflow). */
  diff: string;
  concern: ReviewConcern;
  timeoutMs?: number;
}

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

export async function reviewActivity(input: ReviewInput): Promise<ReviewOutput> {
  const prompt = PROMPTS.review(input.contextArtifact, input.concern, input.step, input.diff);
  const res = await runRefactorCodex({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: REVIEW_TIMEOUT_MS,
  });
  return parseReviewOutput(res.lastMessage, input.concern);
}
