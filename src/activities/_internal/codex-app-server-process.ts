/**
 * Manages the lifecycle of an in-process `codex app-server` child process.
 *
 * Called once at worker startup (see worker.ts).  The server listens on
 * 127.0.0.1:8765 and is reachable by the same process that spawned it.
 * auth.json must be present at $HOME/.codex/auth.json in the worker container.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';

const APP_SERVER_PORT = 8765;
const READY_POLL_INTERVAL_MS = 500;
const READY_TIMEOUT_MS = 30_000;

export interface AppServerHandle {
  url: string;
  stop: () => void;
}

export async function startCodexAppServerProcess(): Promise<AppServerHandle> {
  const port = APP_SERVER_PORT;
  const url = `ws://127.0.0.1:${port}`;

  // stdio:'inherit' — app-server logs flow directly to the worker container's
  // stdout/stderr, which is what log collectors (CloudWatch, GKE Logging) expect.
  const proc = spawn('codex', ['app-server', '--listen', `ws://0.0.0.0:${port}`], {
    stdio: 'inherit',
  });

  await waitForReady(proc, port, READY_TIMEOUT_MS);

  proc.on('exit', (code, signal) => {
    console.error(`[codex-app-server] exited unexpectedly: code=${code} signal=${signal}`);
  });

  return {
    url,
    stop: () => {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    },
  };
}

function waitForReady(proc: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      proc.off('error', onProcError);
      proc.off('exit', onProcExit);
      clearTimeout(globalTimer);
      if (err) reject(err);
      else resolve();
    };

    const onProcError = (err: Error) =>
      finish(new Error(`codex app-server failed to start: ${err.message}`));
    const onProcExit = (code: number | null) =>
      finish(new Error(`codex app-server exited prematurely (code ${code})`));

    proc.once('error', onProcError);
    proc.once('exit', onProcExit);

    const globalTimer = setTimeout(() => {
      proc.kill();
      finish(new Error(`codex app-server did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const poll = () => {
      if (done) return;
      const req = http.get(`http://127.0.0.1:${port}/readyz`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          finish();
        } else {
          setTimeout(poll, READY_POLL_INTERVAL_MS);
        }
      });
      req.on('error', () => {
        if (!done) setTimeout(poll, READY_POLL_INTERVAL_MS);
      });
      req.setTimeout(1000, () => req.destroy());
    };

    setTimeout(poll, READY_POLL_INTERVAL_MS);
  });
}
