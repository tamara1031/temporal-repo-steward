import 'dotenv/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { TASK_QUEUE } from './constants';

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
    workflowsPath: require.resolve('./workflows'),
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
