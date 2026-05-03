import { runRefactorCodex } from './_internal/codex-runner';
import { parsePlanOutput } from './_internal/parsers';
import { PROMPTS } from './_internal/prompts';
import type { ContextArtifact, PlanOutput } from './_internal/types';

export interface PlanInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  brief?: string;
  /** Optional override (default 5 min — within plan proxy's startToCloseTimeout). */
  timeoutMs?: number;
}

const PLAN_TIMEOUT_MS = 5 * 60 * 1000;

export async function planActivity(input: PlanInput): Promise<PlanOutput> {
  const prompt = PROMPTS.plan(input.contextArtifact, input.brief);
  const res = await runRefactorCodex({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: PLAN_TIMEOUT_MS,
  });
  return parsePlanOutput(res.lastMessage);
}
