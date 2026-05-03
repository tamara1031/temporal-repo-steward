import { runCodexExec } from '../_internal/run-codex';
import { parsePlanOutput } from './_internal/parsers';
import { PROMPTS } from './_internal/prompts';
import type { ContextArtifact, PlanOutput } from './_internal/types';

export interface RefinePlanInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  plan: PlanOutput;
  /** Consolidated feedback from all plan reviewers, prefixed with concern tag. */
  feedback: string[];
  timeoutMs?: number;
}

const REFINE_PLAN_TIMEOUT_MS = 5 * 60 * 1000;

export async function refinePlanActivity(input: RefinePlanInput): Promise<PlanOutput> {
  const prompt = PROMPTS.refinePlan(input.contextArtifact, input.plan, input.feedback);
  const res = await runCodexExec({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs ?? REFINE_PLAN_TIMEOUT_MS,
  });
  return parsePlanOutput(res.lastMessage);
}
