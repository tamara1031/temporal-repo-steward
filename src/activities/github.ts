import { ApplicationFailure, Context, log } from '@temporalio/activity';
import { execCommand, execOrThrow } from './_exec';

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

interface RollupCheck {
  name: string;
  state?: string;       // CheckRun: COMPLETED|IN_PROGRESS|QUEUED|PENDING|REQUESTED. StatusContext: PENDING|SUCCESS|ERROR|FAILURE|EXPECTED.
  conclusion?: string;  // CheckRun: SUCCESS|FAILURE|NEUTRAL|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STALE|SKIPPED|STARTUP_FAILURE.
  workflowName?: string;
  detailsUrl?: string;
}

interface PRChecksJSON {
  statusCheckRollup: RollupCheck[];
}

const TERMINAL_STATUS_STATES = new Set(['SUCCESS', 'FAILURE', 'ERROR']);
const PASSING_OUTCOMES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE']);

interface CheckOutcome {
  done: boolean;
  passed: boolean;
}

function classifyCheck(c: RollupCheck): CheckOutcome {
  // CheckRun objects expose `conclusion` once the run finishes.
  if (c.conclusion) {
    return { done: true, passed: PASSING_OUTCOMES.has(c.conclusion) };
  }
  // StatusContext objects only expose `state`. PENDING / EXPECTED means in flight.
  if (c.state && TERMINAL_STATUS_STATES.has(c.state)) {
    return { done: true, passed: c.state === 'SUCCESS' };
  }
  return { done: false, passed: false };
}

function extractRunId(detailsUrl?: string): string | undefined {
  if (!detailsUrl) return undefined;
  // Sample: https://github.com/owner/repo/actions/runs/1234567890/job/9876543210
  const m = detailsUrl.match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : undefined;
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
    const data = JSON.parse(view.stdout) as PRChecksJSON;
    const checks = data.statusCheckRollup ?? [];

    if (checks.length === 0) {
      log.info('No CI checks configured for PR — treating as success', { pr: input.prNumber });
      return { status: 'success', failedRunIds: [], failedJobNames: [] };
    }

    const outcomes = checks.map((c) => ({ check: c, outcome: classifyCheck(c) }));
    const allDone = outcomes.every((o) => o.outcome.done);

    if (allDone) {
      const failed = outcomes.filter((o) => !o.outcome.passed).map((o) => o.check);
      if (failed.length === 0) {
        return { status: 'success', failedRunIds: [], failedJobNames: [] };
      }
      const failedRunIds = Array.from(
        new Set(failed.map((c) => extractRunId(c.detailsUrl)).filter(Boolean) as string[]),
      );
      return {
        status: 'failure',
        failedRunIds,
        failedJobNames: failed.map((c) => c.name),
      };
    }

    await sleepCancellable(interval, ctx.cancellationSignal);
  }
  return { status: 'timeout', failedRunIds: [], failedJobNames: [] };
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
