import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import * as activities from './activities';
import { loadWorkerRuntimeConfig } from './runtime-config';
import {
  startCodexAppServerProcess,
  type AppServerHandle,
} from './activities/_internal/codex-app-server-process';

/**
 * Resolve workflow source for the Worker. Production uses a pre-bundled file
 * emitted by `scripts/build-workflow-bundle.ts` (no bundle-at-startup); local
 * dev (`npm run start.worker.dev`) falls back to `workflowsPath` so iterative
 * edits don't require a rebuild.
 */
function resolveWorkflowSource(): Pick<WorkerOptions, 'workflowBundle' | 'workflowsPath'> {
  const bundlePath = path.resolve(__dirname, '..', 'dist', 'workflow-bundle.js');
  if (fs.existsSync(bundlePath)) {
    return { workflowBundle: { codePath: bundlePath } };
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `production worker requires a pre-built workflow bundle at ${bundlePath}; ` +
        'run `npm run build:workflows` (or build the Docker image, which does it for you).',
    );
  }
  // Dev fallback: bundle at startup. Slow but convenient for `start.worker.dev`.
  return { workflowsPath: require.resolve('./workflows') };
}

async function maybeStartInternalAppServer(): Promise<AppServerHandle | null> {
  if (process.env.CODEX_APP_SERVER_URL) {
    console.log(`[worker] using external codex app-server at ${process.env.CODEX_APP_SERVER_URL}`);
    return null;
  }
  try {
    console.log('[worker] starting codex app-server in-process...');
    const handle = await startCodexAppServerProcess();
    process.env.CODEX_APP_SERVER_URL = handle.url;
    console.log(`[worker] codex app-server ready at ${handle.url}`);
    return handle;
  } catch (err) {
    console.warn(
      '[worker] codex app-server could not start, falling back to subprocess mode:',
      String(err),
    );
    return null;
  }
}

async function run(): Promise<void> {
  const appServer = await maybeStartInternalAppServer();

  const config = loadWorkerRuntimeConfig();

  const connection = await NativeConnection.connect({
    address: config.address,
    tls: config.tls,
  });

  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    ...resolveWorkflowSource(),
    activities,
    // Reasonable defaults for an LLM-heavy worker; tune via env if needed.
    maxConcurrentActivityTaskExecutions: config.maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions: config.maxConcurrentWorkflowTaskExecutions,
  });

  console.log(
    `[worker] connected to ${config.address}, namespace=${config.namespace}, queue=${config.taskQueue}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    worker.shutdown();
    appServer?.stop();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await worker.run();
  await connection.close();
  appServer?.stop();
}

run().catch((err) => {
  console.error('[worker] fatal error', err);
  process.exit(1);
});
