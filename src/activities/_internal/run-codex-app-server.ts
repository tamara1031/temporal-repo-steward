/**
 * JSON-RPC 2.0 WebSocket client for the `codex app-server` sidecar.
 *
 * Each call opens one WebSocket connection, completes the JSON-RPC handshake,
 * starts an ephemeral thread, runs one turn, and closes the socket.
 * One-socket-per-call keeps concurrent activity invocations isolated without
 * connection-pool complexity.
 *
 * Startup retry: the app-server sidecar may still be initialising when the
 * first codex activity runs.  `connectWithRetry` retries on ECONNREFUSED for
 * up to 30 s so the worker never needs to delay its own boot sequence.
 *
 * Authentication is handled by the sidecar container — auth.json is mounted
 * there, not in the worker container.  The worker passes no credentials.
 *
 * Protocol reference: https://developers.openai.com/codex/app-server
 */

import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import * as WebSocket from 'ws';
import { ERR_RATE_LIMITED, ERR_CODEX_INVOCATION } from '../../errors';
import type { CodexRunInput, CodexRunOutput } from './run-codex';

const CONNECT_RETRY_INTERVAL_MS = 500;
const CONNECT_RETRY_MAX_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

// ── Public entry point ────────────────────────────────────────────────────────

export async function runCodexAppServer(
  appServerUrl: string,
  input: CodexRunInput,
): Promise<CodexRunOutput> {
  const ws = await connectWithRetry(appServerUrl);
  const session = new AppServerSession(ws);
  try {
    // Handshake
    await session.request('initialize', {
      clientInfo: {
        name: 'temporal-repo-steward',
        title: 'Temporal Repo Steward',
        version: '1.0.0',
      },
    });
    session.notify('initialized');

    // Start ephemeral thread. thread/start only needs the thread-level options;
    // cwd, sandbox, and approvalPolicy go on turn/start.
    const threadResult = await session.request('thread/start', { ephemeral: true });
    const threadId = ((threadResult as Record<string, unknown>)
      .thread as Record<string, unknown>)
      .id as string;

    return await runTurn(session, threadId, input.workdir, input.model, input.prompt);
  } finally {
    ws.close();
  }
}

// ── Turn streaming ────────────────────────────────────────────────────────────

async function runTurn(
  session: AppServerSession,
  threadId: string,
  cwd: string,
  model: string | undefined,
  prompt: string,
): Promise<CodexRunOutput> {
  const chunks: string[] = [];
  let turnId: string | undefined;
  let settled = false;
  // Defined outside the Promise so .finally() can clear it regardless of path.
  let hbTimer: ReturnType<typeof setInterval> | undefined;

  return new Promise<CodexRunOutput>((resolve, reject) => {
    // Reject immediately if the socket closes or errors during streaming.
    // Without this, a sidecar crash after turn/start resolves would leave
    // the Promise pending until the activity's startToCloseTimeout fires.
    session.onDisconnect((err) => {
      if (!settled) {
        settled = true;
        reject(
          ApplicationFailure.create({
            message: `app-server WebSocket closed during turn: ${err?.message ?? 'connection lost'}`,
            type: ERR_CODEX_INVOCATION,
          }),
        );
      }
    });

    // Heartbeat every 10 s to keep the Temporal activity alive.
    // heartbeat() throws CancelledFailure when the activity has been
    // cancelled by the Temporal server; we propagate that and send a
    // best-effort turn/interrupt so the sidecar aborts the in-flight turn.
    hbTimer = setInterval(() => {
      try {
        heartbeat();
      } catch (cancelErr) {
        if (!settled) {
          settled = true;
          clearInterval(hbTimer);
          if (turnId) {
            try {
              session.notify('turn/interrupt', { threadId, turnId });
            } catch {
              /* best-effort */
            }
          }
          reject(cancelErr);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);

    session.onNotification((msg: Record<string, unknown>) => {
      const method = msg.method as string | undefined;
      const params = msg.params as Record<string, unknown> | undefined;
      const turn = params?.turn as Record<string, unknown> | undefined;

      if (method === 'item/agentMessage/delta') {
        // delta is the text string directly (not a nested object).
        const delta = params?.delta;
        if (typeof delta === 'string' && delta) chunks.push(delta);
        return;
      }

      if (method === 'turn/completed') {
        if (settled) return;
        settled = true;
        clearInterval(hbTimer);

        const status = turn?.status as string | undefined;
        if (status === 'failed') {
          const err = turn?.error as Record<string, unknown> | undefined;
          const errMsg = typeof err?.message === 'string' ? err.message : 'turn failed';
          const httpCode =
            typeof err?.httpStatusCode === 'number' ? err.httpStatusCode : 0;
          reject(classifyError(errMsg, httpCode));
          return;
        }
        // 'completed' or 'interrupted' — extract accumulated message.
        let lastMessage = chunks.join('').trim();
        if (!lastMessage) {
          lastMessage = extractFromTurnItems((turn?.items as unknown[]) ?? []);
        }
        resolve({ lastMessage, stdoutForLog: lastMessage });
      }
    });

    // Kick off the turn. Capture turnId from response for interrupt-on-cancel.
    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: prompt }],
      cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    };
    if (model) turnParams.model = model;

    session
      .request('turn/start', turnParams)
      .then((result) => {
        const r = result as Record<string, unknown>;
        const t = r?.turn as Record<string, unknown> | undefined;
        if (typeof t?.id === 'string') turnId = t.id;
      })
      .catch((err: Error) => {
        if (!settled) {
          settled = true;
          clearInterval(hbTimer);
          reject(classifyError(err.message, 0));
        }
      });
  }).finally(() => clearInterval(hbTimer));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractFromTurnItems(items: unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const i = item as Record<string, unknown>;
    if (i?.type !== 'agentMessage') continue;
    for (const content of (i?.content as unknown[]) ?? []) {
      const c = content as Record<string, unknown>;
      if (c?.type === 'output_text' && typeof c?.text === 'string') {
        parts.push(c.text);
      }
    }
  }
  return parts.join('').trim();
}

function classifyError(message: string, httpStatusCode: number): ApplicationFailure {
  if (httpStatusCode === 429 || isRateLimitText(message)) {
    return ApplicationFailure.create({
      message: `codex app-server rate limit: ${message}`,
      type: ERR_RATE_LIMITED,
    });
  }
  return ApplicationFailure.create({
    message: `codex app-server turn failed: ${message}`,
    type: ERR_CODEX_INVOCATION,
  });
}

function isRateLimitText(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('rate-limit') ||
    lower.includes('too many requests') ||
    lower.includes('quota')
  );
}

// ── Session ───────────────────────────────────────────────────────────────────

class AppServerSession {
  private readonly ws: WebSocket.WebSocket;
  private readonly pending = new Map<
    number,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private notificationHandler: ((msg: Record<string, unknown>) => void) | null = null;
  private idCounter = 0;

  constructor(ws: WebSocket.WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = parseJson(data);
      if (!msg) return;
      if (msg.id != null) {
        const p = this.pending.get(msg.id as number);
        if (p) {
          this.pending.delete(msg.id as number);
          const err = msg.error as { code: number; message: string } | undefined;
          if (err) {
            p.reject(new Error(`JSON-RPC ${err.code}: ${err.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } else {
        this.notificationHandler?.(msg as Record<string, unknown>);
      }
    });
    ws.on('error', (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.ws.send(JSON.stringify(msg));
  }

  onNotification(handler: (msg: Record<string, unknown>) => void): void {
    this.notificationHandler = handler;
  }

  /**
   * Register a handler called at most once when the underlying WebSocket
   * closes or errors.  Used to abort in-flight turn streaming.
   */
  onDisconnect(handler: (err?: Error) => void): void {
    let fired = false;
    const fire = (err?: Error) => {
      if (!fired) {
        fired = true;
        handler(err);
      }
    };
    this.ws.once('close', () => fire());
    this.ws.once('error', fire);
  }
}

// ── Connection helpers ────────────────────────────────────────────────────────

async function connectWithRetry(url: string): Promise<WebSocket.WebSocket> {
  const deadline = Date.now() + CONNECT_RETRY_MAX_MS;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await openWebSocket(url);
    } catch (err) {
      lastErr = err;
      const remaining = deadline - Date.now();
      if (remaining > CONNECT_RETRY_INTERVAL_MS) {
        await new Promise<void>((r) => setTimeout(r, CONNECT_RETRY_INTERVAL_MS));
      }
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw ApplicationFailure.create({
    message: `codex app-server unreachable at ${url} after ${CONNECT_RETRY_MAX_MS}ms: ${detail}`,
    type: ERR_CODEX_INVOCATION,
  });
}

function openWebSocket(url: string): Promise<WebSocket.WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket.WebSocket(url);
    ws.once('open', () => {
      ws.removeAllListeners('error');
      resolve(ws);
    });
    ws.once('error', (err) => {
      ws.removeAllListeners('open');
      reject(err);
    });
  });
}

function parseJson(data: WebSocket.RawData): Record<string, unknown> | null {
  try {
    return JSON.parse(data.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
