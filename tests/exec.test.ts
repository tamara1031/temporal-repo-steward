import { describe, it, expect } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { execCommand, execOrThrow, CommandFailed } from '../src/activities/exec';

describe('exec helpers', () => {
  it('executes a command and captures stdout', async () => {
    const env = new MockActivityEnvironment();
    const res = await env.run(async () => execCommand('printf', ['hello']));
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hello');
  });

  it('passes stdin through', async () => {
    const env = new MockActivityEnvironment();
    const res = await env.run(async () =>
      execCommand('cat', [], { input: 'piped-in\n' }),
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('piped-in\n');
  });

  it('throws CommandFailed for non-zero exit', async () => {
    const env = new MockActivityEnvironment();
    await expect(
      env.run(async () => execOrThrow('sh', ['-c', 'exit 7'])),
    ).rejects.toBeInstanceOf(CommandFailed);
  });

  it('runs outside an activity context (no Temporal hooks)', async () => {
    const res = await execCommand('printf', ['ok']);
    expect(res.stdout).toBe('ok');
  });

  it('marks timeout in stderr and forces non-zero code', async () => {
    const env = new MockActivityEnvironment();
    const res = await env.run(async () =>
      execCommand('sh', ['-c', 'sleep 5'], { timeoutMs: 200 }),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('command timed out');
  });
});
