import { describe, expect, it } from 'vitest';
import { TASK_QUEUE } from '../src/constants';
import {
  loadTemporalRuntimeConfig,
  loadWorkerRuntimeConfig,
} from '../src/runtime-config';

describe('runtime config', () => {
  it('uses Temporal defaults when env vars are unset', () => {
    expect(loadTemporalRuntimeConfig({})).toEqual({
      address: 'localhost:7233',
      namespace: 'default',
      taskQueue: TASK_QUEUE,
    });
  });

  it('uses Temporal env var overrides', () => {
    expect(
      loadTemporalRuntimeConfig({
        TEMPORAL_ADDRESS: 'temporal.example:7233',
        TEMPORAL_NAMESPACE: 'repo-steward',
        TEMPORAL_TASK_QUEUE: 'custom-queue',
      }),
    ).toEqual({
      address: 'temporal.example:7233',
      namespace: 'repo-steward',
      taskQueue: 'custom-queue',
    });
  });

  it('uses worker defaults when worker-only env vars are unset', () => {
    expect(loadWorkerRuntimeConfig({})).toMatchObject({
      tls: false,
      maxConcurrentActivityTaskExecutions: 4,
      maxConcurrentWorkflowTaskExecutions: 20,
    });
  });

  it('uses worker-only env var overrides', () => {
    expect(
      loadWorkerRuntimeConfig({
        TEMPORAL_TLS: 'true',
        TEMPORAL_MAX_CONCURRENT_ACTIVITIES: '8',
        TEMPORAL_MAX_CONCURRENT_WORKFLOWS: '12',
      }),
    ).toMatchObject({
      tls: true,
      maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentWorkflowTaskExecutions: 12,
    });
  });

  it.each([
    ['TEMPORAL_MAX_CONCURRENT_ACTIVITIES', { TEMPORAL_MAX_CONCURRENT_ACTIVITIES: 'abc' }],
    ['TEMPORAL_MAX_CONCURRENT_ACTIVITIES', { TEMPORAL_MAX_CONCURRENT_ACTIVITIES: '0' }],
    ['TEMPORAL_MAX_CONCURRENT_WORKFLOWS', { TEMPORAL_MAX_CONCURRENT_WORKFLOWS: '2.5' }],
    ['TEMPORAL_MAX_CONCURRENT_WORKFLOWS', { TEMPORAL_MAX_CONCURRENT_WORKFLOWS: '' }],
  ])('rejects invalid %s values', (name, env) => {
    expect(() => loadWorkerRuntimeConfig(env)).toThrow(
      `${name} must be a positive integer`,
    );
  });
});
