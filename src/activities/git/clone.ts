import { execOrThrow } from '../_internal/exec';
import {
  fetchRemoteBranchRefSpec,
  prepareGitWorkspace,
  remoteBranchRef,
} from './_internal/git-env';

export interface CloneInput {
  repoFullName: string;
  ref?: string;
  branch: string;
  workspaceRoot?: string;
}

export interface CloneOutput {
  workdir: string;
  branch: string;
  baseSha: string;
}

export async function cloneRepoActivity(input: CloneInput): Promise<CloneOutput> {
  const { workdir, env } = await prepareGitWorkspace({
    repoFullName: input.repoFullName,
    workspaceRoot: input.workspaceRoot,
  });

  if (input.ref) {
    const remoteRef = remoteBranchRef(input.ref);
    await execOrThrow(
      'git',
      ['fetch', '--depth', '50', 'origin', fetchRemoteBranchRefSpec(input.ref)],
      { cwd: workdir, env },
    );
    await execOrThrow('git', ['checkout', '--detach', remoteRef], { cwd: workdir });
  }

  await execOrThrow('git', ['checkout', '-b', input.branch], { cwd: workdir });

  const headRes = await execOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workdir });
  return {
    workdir,
    branch: input.branch,
    baseSha: headRes.stdout.trim(),
  };
}
