import { runRefactorCodex } from './_internal/codex-runner';
import { PROMPTS } from './_internal/prompts';
import type { ContextArtifact, PlanStep } from './_internal/types';

export interface ImplementInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  step: PlanStep;
  /** Reviewer feedback aggregated from prior iterations of this same step. */
  priorFeedback: string[];
  timeoutMs?: number;
}

export interface ImplementOutput {
  /** Markdown report from codex (truncated to fit Temporal payload limits). */
  report: string;
}

const IMPLEMENT_TIMEOUT_MS = 30 * 60 * 1000;
const REPORT_MAX_BYTES = 16 * 1024;

export async function implementActivity(input: ImplementInput): Promise<ImplementOutput> {
  const prompt = PROMPTS.implement(input.contextArtifact, input.step, input.priorFeedback);
  const res = await runRefactorCodex({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: IMPLEMENT_TIMEOUT_MS,
  });
  return { report: res.lastMessage.slice(0, REPORT_MAX_BYTES) };
}
