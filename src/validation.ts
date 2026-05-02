export const AGENT_BRANCH_PREFIX = 'agent/refactor/';

const MAX_GIT_REF_LENGTH = 255;
const MAX_AGENT_BRANCH_SUFFIX_LENGTH = 120;
const FALLBACK_AGENT_BRANCH_SUFFIX = 'workflow';

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export function assertValidRepoFullName(repoFullName: string): void {
  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidInputError('repoFullName must be in owner/repo form');
  }

  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) {
    throw new InvalidInputError(`invalid GitHub owner name: ${owner}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo.endsWith('.git')) {
    throw new InvalidInputError(`invalid GitHub repository name: ${repo}`);
  }
}

export function assertValidGitBranchName(branch: string, fieldName = 'branch'): void {
  if (!branch) {
    throw new InvalidInputError(`${fieldName} must not be empty`);
  }
  if (branch.length > MAX_GIT_REF_LENGTH) {
    throw new InvalidInputError(`${fieldName} exceeds ${MAX_GIT_REF_LENGTH} characters`);
  }
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) {
    throw new InvalidInputError(`${fieldName} has invalid leading or trailing characters`);
  }
  if (
    branch === '@' ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.includes('\\')
  ) {
    throw new InvalidInputError(`${fieldName} contains an invalid git ref sequence`);
  }
  if (/[\x00-\x20\x7f~^:?*\[]/.test(branch)) {
    throw new InvalidInputError(`${fieldName} contains characters disallowed by git refs`);
  }
  for (const component of branch.split('/')) {
    if (!component || component.startsWith('.') || component.endsWith('.lock')) {
      throw new InvalidInputError(`${fieldName} contains an invalid path component`);
    }
  }
}

export function makeAgentRefactorBranch(workflowId: string): string {
  const normalized = workflowId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '');
  const suffix =
    normalized.slice(0, MAX_AGENT_BRANCH_SUFFIX_LENGTH).replace(/[.-]+$/, '') ||
    FALLBACK_AGENT_BRANCH_SUFFIX;
  const branch = `${AGENT_BRANCH_PREFIX}${suffix}`;
  assertValidGitBranchName(branch, 'agent branch');
  return branch;
}

export function assertValidPeriodicRefactorTarget(input: {
  repoFullName: string;
  baseBranch?: string;
}): void {
  assertValidRepoFullName(input.repoFullName);
  if (input.baseBranch !== undefined) {
    assertValidGitBranchName(input.baseBranch, 'baseBranch');
  }
}
