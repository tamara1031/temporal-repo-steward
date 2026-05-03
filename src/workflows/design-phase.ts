/**
 * `designPhaseWorkflow` — runs the plan → Design Parliament loop as its own
 * Temporal workflow.
 *
 * Mirrors the pattern of `refactorStepWorkflow`: the parent passes a spawn-
 * budget slice, the child runs its own bookkeeping, and the caller reconciles
 * the deltas from `spawnCounts` on return.
 *
 * Output discriminators:
 *   - `completed`        — plan is ready for the implementation loop
 *   - `no-op`            — planner returned no actionable theme; caller skips
 *   - `plan-failed`      — planner threw a non-retryable error; caller skips
 *   - `budget-exhausted` — not enough budget for even the initial plan call
 */

import { log } from '@temporalio/workflow';
import type { ContextArtifact, DesignPhaseRecord, PlanOutput } from '../activities/refactor';
import { SpawnCounter } from './_internal/spawn-budget';
import {
  runDesignPhase,
  DEFAULT_DESIGN_PHASE_CONFIG,
  type DesignPhaseConfig,
} from './_internal/design-phase-loop';

export { DEFAULT_DESIGN_PHASE_CONFIG, type DesignPhaseConfig } from './_internal/design-phase-loop';

export type DesignPhaseOutcome = 'completed' | 'no-op' | 'plan-failed' | 'budget-exhausted';

export interface DesignPhaseInput {
  workdir: string;
  contextArtifact: ContextArtifact;
  brief?: string;
  /** Slice of the parent's spawn budget the child may consume. */
  spawnBudget: number;
  config: DesignPhaseConfig;
}

export interface DesignPhaseOutput {
  outcome: DesignPhaseOutcome;
  plan?: PlanOutput;
  designRecord?: DesignPhaseRecord;
  /** Codex spawns consumed, broken down by role. */
  spawnCounts: Record<string, number>;
}

export async function designPhaseWorkflow(input: DesignPhaseInput): Promise<DesignPhaseOutput> {
  const spawnCounter = new SpawnCounter(input.spawnBudget);

  log.info('designPhaseWorkflow start', {
    spawnBudget: input.spawnBudget,
    maxRounds: input.config.maxRounds,
  });

  const result = await runDesignPhase({
    workdir: input.workdir,
    contextArtifact: input.contextArtifact,
    brief: input.brief,
    spawnCounter,
    config: input.config,
  });

  const spawnCounts = spawnCounter.summary().perRole;

  log.info('designPhaseWorkflow done', { outcome: result.outcome, spawnCounts });

  if (result.outcome === 'plan-failed' || result.outcome === 'budget-exhausted') {
    return { outcome: result.outcome, spawnCounts };
  }
  return {
    outcome: result.outcome,
    plan: result.plan,
    designRecord: result.record,
    spawnCounts,
  };
}
