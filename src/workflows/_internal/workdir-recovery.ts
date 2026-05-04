import type { EnsureWorkdirInput, EnsureWorkdirOutput } from '../../activities';

type EnsureWorkdirActivity = (input: EnsureWorkdirInput) => Promise<EnsureWorkdirOutput>;

export async function recoverWorkdir(
  ensureWorkdirActivity: EnsureWorkdirActivity,
  input: EnsureWorkdirInput,
): Promise<string> {
  const result = await ensureWorkdirActivity(input);
  return result.workdir;
}
