import { ApplicationFailure, Context, log } from '@temporalio/activity';
import { execCommand, execOrThrow } from './exec';
import {
  decideCIStatus,
  parseStatusCheckRollupJSON,
  type CompletedCIDecision,
} from './github-ci';
import { invalidGhOutput, isRecord, parseGhJSON } from './github-json';

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

export interface PRViewJSON {
  number: number;
  url: string;
}

export function parsePRViewJSON(stdout: string): PRViewJSON {
  const data = parseGhJSON(stdout, 'gh pr view --json number,url');
  if (!isRecord(data)) {
    throw invalidGhOutput('gh pr view --json number,url output must be a JSON object');
  }
  if (typeof data.number !== 'number') {
    throw invalidGhOutput('gh pr view --json number,url output is missing numeric field "number"');
  }
  if (typeof data.url !== 'string') {
    throw invalidGhOutput('gh pr view --json number,url output is missing string field "url"');
  }
  return { number: data.number, url: data.url };
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
  const parsed = parsePRViewJSON(view.stdout);
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

export async function waitForCIActivity(input: WaitForCIInput): Promise<CIResult> {
  const env = ghEnv();
  const interval = (input.pollIntervalSeconds ?? 30) * 1000;
  const deadline = Date.now() + (input.maxWaitSeconds ?? 60 * 60) * 1000;
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
    const checks = parseStatusCheckRollupJSON(view.stdout);
    const decision = decideCIStatus(checks);

    if (decision.status === 'success' && checks.length === 0) {
      log.info('No CI checks configured for PR — treating as success', { pr: input.prNumber });
      return toCIResult(decision);
    }

    if (decision.status !== 'pending') {
      return toCIResult(decision);
    }

    await sleepCancellable(interval, ctx.cancellationSignal);
  }
  return { status: 'timeout', failedRunIds: [], failedJobNames: [] };
}

function toCIResult(decision: CompletedCIDecision): CIResult {
  return {
    status: decision.status,
    failedRunIds: decision.failedRunIds,
    failedJobNames: decision.failedJobNames,
  };
}

function sleepCancellable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
