import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';
import * as activities from './activities';
import { TASK_QUEUE } from './constants';

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

async function run(): Promise<void> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? TASK_QUEUE;

  const connection = await NativeConnection.connect({
    address,
    tls: process.env.TEMPORAL_TLS === 'true' ? true : false,
  });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    ...resolveWorkflowSource(),
    activities,
    // Reasonable defaults for an LLM-heavy worker; tune via env if needed.
    maxConcurrentActivityTaskExecutions: Number(
      process.env.TEMPORAL_MAX_CONCURRENT_ACTIVITIES ?? 4,
    ),
    maxConcurrentWorkflowTaskExecutions: Number(
      process.env.TEMPORAL_MAX_CONCURRENT_WORKFLOWS ?? 20,
    ),
  });

  console.log(
    `[worker] connected to ${address}, namespace=${namespace}, queue=${taskQueue}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal}, shutting down`);
    worker.shutdown();
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await worker.run();
  await connection.close();
}

run().catch((err) => {
  console.error('[worker] fatal error', err);
  process.exit(1);
});
