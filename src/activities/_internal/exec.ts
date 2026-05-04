import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { Context, CancelledFailure, ApplicationFailure } from '@temporalio/activity';
import { ERR_WORKDIR_MISSING } from '../../errors';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Heartbeat interval; pass 0 to disable. */
  heartbeatMs?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandFailed extends Error {
  constructor(
    public readonly command: string,
    public readonly args: readonly string[],
    public readonly result: ExecResult,
  ) {
    super(
      `Command '${command} ${args.join(' ')}' exited with code ${result.code}: ` +
        `${result.stderr.slice(0, 1024)}`,
    );
    this.name = 'CommandFailed';
  }
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MS = 5_000;

interface ActivityHooks {
  heartbeat: (details: unknown) => void;
  abortSignal: AbortSignal | undefined;
}

function getActivityHooks(): ActivityHooks {
  try {
    const ctx = Context.current();
    return {
      heartbeat: (d) => ctx.heartbeat(d),
      abortSignal: ctx.cancellationSignal,
    };
  } catch {
    // Not running inside a Temporal activity (e.g. unit tests, ad-hoc scripts).
    return { heartbeat: () => undefined, abortSignal: undefined };
  }
}

export async function execCommand(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (options.cwd) {
    try {
      await fs.stat(options.cwd);
    } catch {
      throw ApplicationFailure.nonRetryable(
        `Workdir missing: ${options.cwd}`,
        ERR_WORKDIR_MISSING,
      );
    }
  }

  const hooks = getActivityHooks();
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

  return await new Promise<ExecResult>((resolve, reject) => {
    // `detached: true` makes the child the leader of a new process group on
    // Linux. We need this so that on cancel / timeout we can kill the entire
    // tree (e.g. codex orchestrator → subagent codex processes) by signaling
    // the process group via `process.kill(-pid)`. Without it, only the direct
    // child receives SIGTERM and grandchildren survive as orphans, which is
    // exactly what bit us during a workflow terminate (subagent codex runs
    // continued for ~6 min after the parent activity was cancelled).
    //
    // Note: we deliberately do NOT call `child.unref()`. We still want the
    // event loop to track this child until it exits.
    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let cancelled = false;
    let timedOut = false;

    const heartbeatInterval =
      heartbeatMs > 0
        ? setInterval(() => hooks.heartbeat({ command, pid: child.pid }), heartbeatMs)
        : undefined;

    /**
     * Kill the child AND every descendant by signaling the process group.
     * On Linux, `process.kill(-pid, sig)` (negative pid) sends `sig` to every
     * process whose PGID equals `pid`. Because we spawned with detached:true,
     * `child.pid` is itself the PGID.
     */
    const signalGroup = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig);
      } catch (err) {
        // ESRCH = the group is already gone. Anything else: fall back to a
        // direct signal on the leader so we at least try.
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          try {
            child.kill(sig);
          } catch {
            /* leader already exited too */
          }
        }
      }
    };

    const killChild = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalGroup('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          signalGroup('SIGKILL');
        }
      }, 5_000).unref();
    };

    const onCancel = (): void => {
      cancelled = true;
      killChild();
    };

    if (hooks.abortSignal) {
      if (hooks.abortSignal.aborted) {
        // Already cancelled before spawn settled — kill immediately.
        onCancel();
      } else {
        hooks.abortSignal.addEventListener('abort', onCancel, { once: true });
      }
    }

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
      }, options.timeoutMs);
    }

    const cleanup = (): void => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      if (timer) clearTimeout(timer);
      if (hooks.abortSignal) hooks.abortSignal.removeEventListener('abort', onCancel);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdoutBuf.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderrBuf.push(chunk);
    });

    child.once('error', (err) => {
      cleanup();
      reject(err);
    });

    child.once('close', (code) => {
      cleanup();
      const result: ExecResult = {
        code: code ?? -1,
        stdout: Buffer.concat(stdoutBuf).toString('utf8'),
        stderr: Buffer.concat(stderrBuf).toString('utf8'),
      };
      if (cancelled) {
        // Surface as Temporal CancelledFailure so the workflow side observes
        // a clean cancellation rather than a generic command failure.
        return reject(new CancelledFailure(`Command '${command}' cancelled`));
      }
      if (timedOut) {
        result.stderr += `\n[exec] command timed out after ${options.timeoutMs}ms`;
        result.code = result.code === 0 ? 124 : result.code;
      }
      resolve(result);
    });

    // Suppress EPIPE: the child may exit before stdin is fully drained.
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

export async function execOrThrow(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const res = await execCommand(command, args, options);
  if (res.code !== 0) {
    throw new CommandFailed(command, args, res);
  }
  return res;
}
