import { runCodexExec, type CodexRunOutput } from '../../_internal/run-codex';

export interface RefactorCodexRunInput {
  workdir: string;
  prompt: string;
  timeoutMs?: number;
  defaultTimeoutMs: number;
}

export async function runRefactorCodex(input: RefactorCodexRunInput): Promise<CodexRunOutput> {
  return runCodexExec({
    workdir: input.workdir,
    prompt: input.prompt,
    timeoutMs: input.timeoutMs ?? input.defaultTimeoutMs,
  });
}
