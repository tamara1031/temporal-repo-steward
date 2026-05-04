import { describe, expect, it } from 'vitest';
import { recoverWorkdir } from '../src/workflows/_internal/workdir-recovery';

describe('recoverWorkdir', () => {
  it('returns the workdir from ensureWorkdirActivity output', async () => {
    const seenInputs: unknown[] = [];
    const recovered = await recoverWorkdir(async (input) => {
      seenInputs.push(input);
      return { workdir: '/tmp/recovered-workdir' };
    }, {
      workdir: '/tmp/original-workdir',
      repoFullName: 'example/repo',
      branch: 'agent/refactor/test',
    });

    expect(recovered).toBe('/tmp/recovered-workdir');
    expect(seenInputs).toEqual([
      {
        workdir: '/tmp/original-workdir',
        repoFullName: 'example/repo',
        branch: 'agent/refactor/test',
      },
    ]);
  });
});
