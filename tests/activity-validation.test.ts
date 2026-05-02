import { ApplicationFailure } from '@temporalio/activity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import { cloneRepoActivity } from '../src/activities/git';
import { createPRActivity } from '../src/activities/github';

function inActivity<R>(fn: () => Promise<R>): Promise<R> {
  return new MockActivityEnvironment().run<[], R, () => Promise<R>>(fn);
}

describe('activity input validation', () => {
  it('fails invalid git activity input as non-retryable before credentials are read', async () => {
    await expect(
      inActivity(() =>
        cloneRepoActivity({
          repoFullName: 'owner',
          branch: 'agent/refactor/test',
        }),
      ),
    ).rejects.toMatchObject({
      type: 'InvalidInput',
      nonRetryable: true,
    } satisfies Partial<ApplicationFailure>);
  });

  it('fails invalid GitHub activity input as non-retryable before credentials are read', async () => {
    await expect(
      inActivity(() =>
        createPRActivity({
          repoFullName: 'owner/repo',
          workdir: '/tmp/mock',
          branch: 'bad branch',
          baseBranch: 'main',
          title: 'title',
          body: 'body',
        }),
      ),
    ).rejects.toMatchObject({
      type: 'InvalidInput',
      nonRetryable: true,
    } satisfies Partial<ApplicationFailure>);
  });
});
