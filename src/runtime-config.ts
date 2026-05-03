import { TASK_QUEUE } from './constants';

type RuntimeEnv = Partial<
  Record<
    | 'TEMPORAL_ADDRESS'
    | 'TEMPORAL_NAMESPACE'
    | 'TEMPORAL_TASK_QUEUE'
    | 'TEMPORAL_TLS'
    | 'TEMPORAL_MAX_CONCURRENT_ACTIVITIES'
    | 'TEMPORAL_MAX_CONCURRENT_WORKFLOWS',
    string
  >
>;

export interface TemporalRuntimeConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  tls: boolean;
}

export interface WorkerRuntimeConfig extends TemporalRuntimeConfig {
  tls: boolean;
  maxConcurrentActivityTaskExecutions: number;
  maxConcurrentWorkflowTaskExecutions: number;
}

export function loadTemporalRuntimeConfig(
  env: RuntimeEnv = process.env,
): TemporalRuntimeConfig {
  return {
    address: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    namespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? TASK_QUEUE,
    tls: env.TEMPORAL_TLS === 'true',
  };
}

export function loadWorkerRuntimeConfig(
  env: RuntimeEnv = process.env,
): WorkerRuntimeConfig {
  return {
    ...loadTemporalRuntimeConfig(env),
    maxConcurrentActivityTaskExecutions: parsePositiveIntegerEnv(
      'TEMPORAL_MAX_CONCURRENT_ACTIVITIES',
      env.TEMPORAL_MAX_CONCURRENT_ACTIVITIES,
      4,
    ),
    maxConcurrentWorkflowTaskExecutions: parsePositiveIntegerEnv(
      'TEMPORAL_MAX_CONCURRENT_WORKFLOWS',
      env.TEMPORAL_MAX_CONCURRENT_WORKFLOWS,
      20,
    ),
  };
}

function parsePositiveIntegerEnv(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${name} must be a positive integer; received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}
