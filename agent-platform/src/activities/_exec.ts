import { spawn } from 'child_process';
import { Context } from '@temporalio/activity';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
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

export async function execCommand(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const ctx = Context.current();
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };

  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args as string[], {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;

    const heartbeatInterval = setInterval(() => {
      try {
        ctx.heartbeat({ command, pid: child.pid });
      } catch {
        // Heartbeat unavailable in non-activity context; ignore.
      }
    }, 5000);

    const cancelAbort = () => {
      if (!killed && !child.killed) {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 5000).unref();
      }
    };

    let cancelHandler: (() => void) | undefined;
    try {
      ctx.cancellationSignal.addEventListener('abort', cancelAbort, { once: true });
      cancelHandler = cancelAbort;
    } catch {
      // Outside activity context — no cancellation hook.
    }

    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        cancelAbort();
        reject(
          new CommandFailed(command, args, {
            code: -1,
            stdout: Buffer.concat(stdoutBuf).toString('utf8'),
            stderr:
              Buffer.concat(stderrBuf).toString('utf8') +
              `\n[exec] command timed out after ${options.timeoutMs}ms`,
          }),
        );
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdoutBuf.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderrBuf.push(chunk);
    });

    child.once('error', (err) => {
      clearInterval(heartbeatInterval);
      if (timer) clearTimeout(timer);
      if (cancelHandler) {
        try {
          ctx.cancellationSignal.removeEventListener('abort', cancelHandler);
        } catch {
          /* ignore */
        }
      }
      reject(err);
    });

    child.once('close', (code) => {
      clearInterval(heartbeatInterval);
      if (timer) clearTimeout(timer);
      if (cancelHandler) {
        try {
          ctx.cancellationSignal.removeEventListener('abort', cancelHandler);
        } catch {
          /* ignore */
        }
      }
      const result: ExecResult = {
        code: code ?? -1,
        stdout: Buffer.concat(stdoutBuf).toString('utf8'),
        stderr: Buffer.concat(stderrBuf).toString('utf8'),
      };
      resolve(result);
    });

    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
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
