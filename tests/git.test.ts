import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  cloneRepoActivity,
  ensureWorkdirActivity,
  fetchRemoteBranchRefSpec,
  remoteBranchRef,
  restoreActivity,
} from '../src/activities/git';
import { execOrThrow } from '../src/activities/_internal/exec';
import { ERR_MISSING_CREDENTIALS } from '../src/errors';

describe('git activity helpers', () => {
  it('builds a remote-tracking ref for non-default base branches', () => {
    expect(remoteBranchRef('release/v1')).toBe('refs/remotes/origin/release/v1');
  });

  it('builds an explicit fetch refspec for shallow clones', () => {
    expect(fetchRemoteBranchRefSpec('develop')).toBe(
      'develop:refs/remotes/origin/develop',
    );
  });

  it('rejects empty base branches before invoking git', () => {
    expect(() => remoteBranchRef('   ')).toThrow('base branch must not be empty');
  });
});

describe('git workspace activity validation', () => {
  const originalEnv = {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GIT_BOT_NAME: process.env.GIT_BOT_NAME,
    GIT_BOT_EMAIL: process.env.GIT_BOT_EMAIL,
  };

  let workspaceRoot = '';

  function restoreEnv(name: keyof typeof originalEnv): void {
    const value = originalEnv[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'git-workspace-validation-'));
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.GIT_BOT_NAME;
    delete process.env.GIT_BOT_EMAIL;
  });

  afterEach(async () => {
    restoreEnv('GITHUB_TOKEN');
    restoreEnv('GIT_BOT_NAME');
    restoreEnv('GIT_BOT_EMAIL');
    if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function inActivity<R>(fn: () => Promise<R>): Promise<R> {
    return new MockActivityEnvironment().run<[], R, () => Promise<R>>(fn);
  }

  async function expectMissingBotIdentity(run: () => Promise<unknown>): Promise<void> {
    await expect(run()).rejects.toMatchObject({
      type: ERR_MISSING_CREDENTIALS,
      nonRetryable: true,
    });
  }

  it('cloneRepoActivity and ensureWorkdirActivity share bot identity validation behavior', async () => {
    await expectMissingBotIdentity(() =>
      inActivity(() =>
        cloneRepoActivity({
          repoFullName: 'owner/repo',
          branch: 'steward/test',
          workspaceRoot,
        }),
      ),
    );

    await expectMissingBotIdentity(() =>
      inActivity(() =>
        ensureWorkdirActivity({
          workdir: path.join(workspaceRoot, 'missing-workdir'),
          repoFullName: 'owner/repo',
          branch: 'steward/test',
          workspaceRoot,
        }),
      ),
    );
  });

  it('ensureWorkdirActivity returns an existing workdir without credential validation', async () => {
    delete process.env.GITHUB_TOKEN;

    await expect(
      inActivity(() =>
        ensureWorkdirActivity({
          workdir: workspaceRoot,
          repoFullName: 'owner/repo',
          branch: 'steward/test',
          workspaceRoot,
        }),
      ),
    ).resolves.toEqual({ workdir: workspaceRoot });
  });
});

describe('restoreActivity', () => {
  let workdir = '';

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-activity-'));
    await execOrThrow('git', ['init', '-q', '-b', 'main'], { cwd: workdir });
    await execOrThrow('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir });
    await execOrThrow('git', ['config', 'user.name', 'test'], { cwd: workdir });
    await execOrThrow('git', ['config', 'commit.gpgsign', 'false'], { cwd: workdir });
    await fs.writeFile(path.join(workdir, 'tracked.txt'), 'original\n');
    await execOrThrow('git', ['add', 'tracked.txt'], { cwd: workdir });
    await execOrThrow('git', ['commit', '-qm', 'init'], { cwd: workdir });
  });

  afterEach(async () => {
    if (workdir) await fs.rm(workdir, { recursive: true, force: true });
  });

  async function status(): Promise<string[]> {
    const res = await execOrThrow('git', ['status', '--porcelain'], { cwd: workdir });
    return res.stdout
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter(Boolean);
  }

  function inActivity<R>(fn: () => Promise<R>): Promise<R> {
    return new MockActivityEnvironment().run<[], R, () => Promise<R>>(fn);
  }

  it('reverts a tracked modification when given as a path', async () => {
    await fs.writeFile(path.join(workdir, 'tracked.txt'), 'CHANGED\n');
    expect(await status()).toEqual([' M tracked.txt']);

    await inActivity(() => restoreActivity({ workdir, paths: ['tracked.txt'] }));

    expect(await status()).toEqual([]);
    expect(await fs.readFile(path.join(workdir, 'tracked.txt'), 'utf8')).toBe('original\n');
  });

  it('removes an untracked file given as a path (the failing scenario in production)', async () => {
    await fs.writeFile(path.join(workdir, 'tracked.txt'), 'CHANGED\n');
    await fs.writeFile(path.join(workdir, 'new.txt'), 'NEW\n');
    expect(await status()).toEqual(
      expect.arrayContaining([' M tracked.txt', '?? new.txt']),
    );

    await inActivity(() =>
      restoreActivity({ workdir, paths: ['tracked.txt', 'new.txt'] }),
    );

    expect(await status()).toEqual([]);
    expect(await fs.readFile(path.join(workdir, 'tracked.txt'), 'utf8')).toBe('original\n');
    await expect(fs.access(path.join(workdir, 'new.txt'))).rejects.toThrow();
  });

  it('removes a staged-add when given as a path', async () => {
    await fs.writeFile(path.join(workdir, 'staged.txt'), 'STAGED\n');
    await execOrThrow('git', ['add', 'staged.txt'], { cwd: workdir });
    expect(await status()).toEqual(['A  staged.txt']);

    await inActivity(() => restoreActivity({ workdir, paths: ['staged.txt'] }));

    expect(await status()).toEqual([]);
    await expect(fs.access(path.join(workdir, 'staged.txt'))).rejects.toThrow();
  });

  it('full restore (no paths) reverts modifications and cleans untracked files', async () => {
    await fs.writeFile(path.join(workdir, 'tracked.txt'), 'CHANGED\n');
    await fs.mkdir(path.join(workdir, 'newdir'));
    await fs.writeFile(path.join(workdir, 'newdir', 'untracked.txt'), 'X\n');

    await inActivity(() => restoreActivity({ workdir }));

    expect(await status()).toEqual([]);
    expect(await fs.readFile(path.join(workdir, 'tracked.txt'), 'utf8')).toBe('original\n');
    await expect(fs.access(path.join(workdir, 'newdir'))).rejects.toThrow();
  });
});
