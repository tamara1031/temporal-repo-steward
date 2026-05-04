import { runRefactorActivity } from './_internal/codex-runner';
import { parseContextOutput } from './_internal/parsers';
import { PROMPTS } from './_internal/prompts';
import type { ContextArtifact } from './_internal/types';

export interface ExtractContextInput {
  workdir: string;
  /** Generated-at timestamp injected by the workflow (Temporal-deterministic). */
  generatedAt: string;
  timeoutMs?: number;
}

const CONTEXT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run codex once over the working tree to produce a `ContextArtifact`.
 * The activity is intentionally cheap and frontloaded — it replaces the
 * implicit per-role repo re-read each subsequent codex call would otherwise do.
 */
export async function extractContextArtifactActivity(
  input: ExtractContextInput,
): Promise<ContextArtifact> {
  const prompt = PROMPTS.context;
  return runRefactorActivity({
    workdir: input.workdir,
    prompt,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: CONTEXT_TIMEOUT_MS,
    mapResult: (res) => {
      const parsed = parseContextOutput(res.lastMessage);
      return { ...parsed, generatedAt: input.generatedAt };
    },
  });
}
