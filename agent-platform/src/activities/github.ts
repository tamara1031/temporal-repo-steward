import { ApplicationFailure } from '@temporalio/activity';
import { execCommand, execOrThrow } from './_exec';
import { ISSUE_LABEL_AI_READY, ISSUE_LABEL_STATUS_PREFIX, IssueStatus } from '../constants';

function ghEnv(): NodeJS.ProcessEnv {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw ApplicationFailure.nonRetryable(
      'GITHUB_TOKEN env var is missing on the worker',
      'MissingCredentials',
    );
  }
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  repoFullName: string;
}

export interface ListIssuesInput {
  repoFullName: string;
  label?: string;
  limit?: number;
}

export async function listAiReadyIssuesActivity(input: ListIssuesInput): Promise<IssueSummary[]> {
  const label = input.label ?? ISSUE_LABEL_AI_READY;
  const limit = input.limit ?? 20;
  const res = await execOrThrow(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      input.repoFullName,
      '--label',
      label,
      '--state',
      'open',
      '--limit',
      String(limit),
      '--json',
      'number,title,body,url,labels',
    ],
    { env: ghEnv() },
  );
  const raw = JSON.parse(res.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    url: string;
    labels: Array<{ name: string }>;
  }>;
  return raw
    .filter((i) => !i.labels.some((l) => l.name.startsWith(ISSUE_LABEL_STATUS_PREFIX)))
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      url: i.url,
      labels: i.labels.map((l) => l.name),
      repoFullName: input.repoFullName,
    }));
}

export interface UpdateIssueStatusInput {
  repoFullName: string;
  number: number;
  status: IssueStatus;
  note?: string;
}

export async function updateIssueStatusActivity(input: UpdateIssueStatusInput): Promise<void> {
  const env = ghEnv();
  // Remove any existing ai-status:* label so transitions are clean.
  const existing = await execOrThrow(
    'gh',
    ['issue', 'view', String(input.number), '--repo', input.repoFullName, '--json', 'labels'],
    { env },
  );
  const labels = (JSON.parse(existing.stdout).labels as Array<{ name: string }>).map((l) => l.name);
  for (const l of labels) {
    if (l.startsWith(ISSUE_LABEL_STATUS_PREFIX)) {
      await execCommand(
        'gh',
        [
          'issue',
          'edit',
          String(input.number),
          '--repo',
          input.repoFullName,
          '--remove-label',
          l,
        ],
        { env },
      );
    }
  }
  const newLabel = `${ISSUE_LABEL_STATUS_PREFIX}${input.status}`;
  await execOrThrow(
    'gh',
    [
      'issue',
      'edit',
      String(input.number),
      '--repo',
      input.repoFullName,
      '--add-label',
      newLabel,
    ],
    { env },
  );
  if (input.note) {
    await execOrThrow(
      'gh',
      ['issue', 'comment', String(input.number), '--repo', input.repoFullName, '--body', input.note],
      { env },
    );
  }
}

export interface CreatePRInput {
  repoFullName: string;
  workdir: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PRInfo {
  number: number;
  url: string;
  branch: string;
  baseBranch: string;
  repoFullName: string;
}

export async function createPRActivity(input: CreatePRInput): Promise<PRInfo> {
  const env = ghEnv();
  const args = [
    'pr',
    'create',
    '--repo',
    input.repoFullName,
    '--base',
    input.baseBranch,
    '--head',
    input.branch,
    '--title',
    input.title,
    '--body',
    input.body,
  ];
  if (input.draft) args.push('--draft');
  await execOrThrow('gh', args, { cwd: input.workdir, env });
  const view = await execOrThrow(
    'gh',
    ['pr', 'view', input.branch, '--repo', input.repoFullName, '--json', 'number,url'],
    { cwd: input.workdir, env },
  );
  const parsed = JSON.parse(view.stdout) as { number: number; url: string };
  return {
    number: parsed.number,
    url: parsed.url,
    branch: input.branch,
    baseBranch: input.baseBranch,
    repoFullName: input.repoFullName,
  };
}

export interface WaitForCIInput {
  repoFullName: string;
  prNumber: number;
  pollIntervalSeconds?: number;
  maxWaitSeconds?: number;
}

export interface CIResult {
  status: 'success' | 'failure' | 'timeout';
  failedRunIds: string[];
  failedJobNames: string[];
}

interface PRChecksJSON {
  statusCheckRollup: Array<{
    name: string;
    state: string;
    conclusion?: string;
    workflowName?: string;
    detailsUrl?: string;
  }>;
}

export async function waitForCIActivity(input: WaitForCIInput): Promise<CIResult> {
  const env = ghEnv();
  const interval = (input.pollIntervalSeconds ?? 30) * 1000;
  const deadline = Date.now() + (input.maxWaitSeconds ?? 60 * 60) * 1000;
  const { Context } = await import('@temporalio/activity');
  const ctx = Context.current();

  while (Date.now() < deadline) {
    ctx.heartbeat({ phase: 'wait-ci', prNumber: input.prNumber });
    const view = await execOrThrow(
      'gh',
      [
        'pr',
        'view',
        String(input.prNumber),
        '--repo',
        input.repoFullName,
        '--json',
        'statusCheckRollup',
      ],
      { env },
    );
    const data = JSON.parse(view.stdout) as PRChecksJSON;
    const checks = data.statusCheckRollup ?? [];
    if (checks.length === 0) {
      // No checks configured — treat as success.
      return { status: 'success', failedRunIds: [], failedJobNames: [] };
    }
    const allDone = checks.every(
      (c) => c.state === 'COMPLETED' || c.state === 'SUCCESS' || c.state === 'FAILURE' || c.conclusion,
    );
    if (allDone) {
      const failed = checks.filter(
        (c) =>
          (c.conclusion ?? c.state) !== 'SUCCESS' &&
          (c.conclusion ?? c.state) !== 'NEUTRAL' &&
          (c.conclusion ?? c.state) !== 'SKIPPED',
      );
      if (failed.length === 0) {
        return { status: 'success', failedRunIds: [], failedJobNames: [] };
      }
      return {
        status: 'failure',
        failedRunIds: failed
          .map((c) => (c.detailsUrl ?? '').split('/').pop() ?? '')
          .filter(Boolean),
        failedJobNames: failed.map((c) => c.name),
      };
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, interval);
      const cancel = () => {
        clearTimeout(t);
        reject(new Error('cancelled'));
      };
      try {
        ctx.cancellationSignal.addEventListener('abort', cancel, { once: true });
      } catch {
        /* ignore */
      }
    });
  }
  return { status: 'timeout', failedRunIds: [], failedJobNames: [] };
}

export interface FetchFailedLogsInput {
  repoFullName: string;
  runId: string;
  maxBytes?: number;
}

export async function fetchFailedRunLogsActivity(input: FetchFailedLogsInput): Promise<string> {
  const env = ghEnv();
  const max = input.maxBytes ?? 256 * 1024;
  const res = await execCommand(
    'gh',
    ['run', 'view', input.runId, '--repo', input.repoFullName, '--log-failed'],
    { env },
  );
  const combined = (res.stdout || '') + (res.code === 0 ? '' : `\n[stderr]\n${res.stderr}`);
  return combined.slice(0, max);
}

export interface MergePRInput {
  repoFullName: string;
  prNumber: number;
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  deleteBranch?: boolean;
}

export async function mergePRActivity(input: MergePRInput): Promise<void> {
  const env = ghEnv();
  const method = input.mergeMethod ?? 'squash';
  const args = [
    'pr',
    'merge',
    String(input.prNumber),
    '--repo',
    input.repoFullName,
    `--${method}`,
    '--auto',
  ];
  if (input.deleteBranch) args.push('--delete-branch');
  await execOrThrow('gh', args, { env });
}
