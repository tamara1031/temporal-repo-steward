import { describe, expect, it } from 'vitest';
import {
  AGENT_BRANCH_PREFIX,
  assertValidGitBranchName,
  assertValidPeriodicRefactorTarget,
  assertValidRepoFullName,
  makeAgentRefactorBranch,
} from '../src/validation';

describe('validation helpers', () => {
  it('accepts normal GitHub repositories and branch names', () => {
    expect(() => assertValidRepoFullName('owner/repo.name-1')).not.toThrow();
    expect(() => assertValidGitBranchName('release/2026.05')).not.toThrow();
    expect(() =>
      assertValidPeriodicRefactorTarget({
        repoFullName: 'octo-org/service_repo',
        baseBranch: 'main',
      }),
    ).not.toThrow();
  });

  it('rejects malformed repository names before they reach gh or git', () => {
    expect(() => assertValidRepoFullName('owner')).toThrow(/owner\/repo/);
    expect(() => assertValidRepoFullName('owner/repo/extra')).toThrow(/owner\/repo/);
    expect(() => assertValidRepoFullName('-owner/repo')).toThrow(/owner name/);
    expect(() => assertValidRepoFullName('owner/repo.git')).toThrow(/repository name/);
  });

  it('rejects branch names that git check-ref-format would not accept', () => {
    for (const branch of [
      '',
      '/main',
      'main/',
      'feature..x',
      'feature.lock/x',
      'feature/x.lock',
      '@',
      'feature/@{upstream}',
      'feature/has space',
      'feature/[glob]',
      'feature\\windows',
    ]) {
      expect(() => assertValidGitBranchName(branch)).toThrow();
    }
  });

  it('turns arbitrary workflow IDs into bounded agent branch names', () => {
    const branch = makeAgentRefactorBranch('scheduled/run:2026-05-02 19:30:00Z');

    expect(branch).toBe(`${AGENT_BRANCH_PREFIX}scheduled-run-2026-05-02-19-30-00Z`);
    expect(branch.length).toBeLessThanOrEqual(AGENT_BRANCH_PREFIX.length + 120);
    expect(() => assertValidGitBranchName(branch)).not.toThrow();
  });

  it('re-normalizes agent branch names after truncating long workflow IDs', () => {
    const branch = makeAgentRefactorBranch(`${'a'.repeat(119)}.still-too-long`);

    expect(branch).toBe(`${AGENT_BRANCH_PREFIX}${'a'.repeat(119)}`);
    expect(() => assertValidGitBranchName(branch)).not.toThrow();
  });

  it('uses a stable fallback when a workflow ID has no branch-safe characters', () => {
    expect(makeAgentRefactorBranch('////::::')).toBe(`${AGENT_BRANCH_PREFIX}workflow`);
  });
});
