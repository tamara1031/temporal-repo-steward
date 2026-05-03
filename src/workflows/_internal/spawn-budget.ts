/**
 * Spawn-budget bookkeeping for codex-driven workflows.
 *
 * Mirrors `easy-agent`'s `max_consults`: the orchestrator counts every codex
 * spawn (context / planner / implementer / reviewers / etc.) against a hard
 * cap, and stops issuing new ones once the budget is exhausted. Workflow
 * state stays small — we keep just `{ total, perRole }` rather than raw
 * codex output.
 *
 * Determinism: pure data structure, no Temporal API. Safe to import from
 * any workflow file.
 */

/**
 * Default spawn cap for `periodicRefactorWorkflow`.
 *
 * Worst-case spawns with the design parliament (maxRounds=1):
 *   1 context + (1 planner + 2 reviewers + 1 refiner) design
 *   + 2 steps × 2 iter × (1 implementer + 2 reviewers) = 17.
 * Cap of 22 leaves a 5-spawn retry buffer for transient failures or an
 * optional second design round.
 */
export const DEFAULT_PERIODIC_SPAWN_CAP = 22;

export class SpawnCounter {
  private readonly counts: Record<string, number> = {};
  private total = 0;
  constructor(private readonly cap: number) {
    assertValidCount('cap', cap);
  }
  canConsume(n: number): boolean {
    return Number.isInteger(n) && n >= 0 && this.total + n <= this.cap;
  }
  consume(role: string, n: number): void {
    this.assertCanConsume(n);
    this.counts[role] = (this.counts[role] ?? 0) + n;
    this.total += n;
  }
  reconcile(spawnCounts: Record<string, number>): void {
    const entries = Object.entries(spawnCounts);
    const delta = entries.reduce((sum, [role, n]) => {
      assertValidCount(role, n);
      return sum + n;
    }, 0);
    this.assertCanConsume(delta);
    for (const [role, n] of entries) {
      this.counts[role] = (this.counts[role] ?? 0) + n;
    }
    this.total += delta;
  }
  remaining(): number {
    return Math.max(0, this.cap - this.total);
  }
  summary(): { total: number; cap: number; perRole: Record<string, number> } {
    return { total: this.total, cap: this.cap, perRole: { ...this.counts } };
  }

  private assertCanConsume(n: number): void {
    assertValidCount('spawn count', n);
    if (this.total + n > this.cap) {
      throw new RangeError(`spawn budget exceeded: ${this.total + n} > ${this.cap}`);
    }
  }
}

function assertValidCount(label: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative finite integer`);
  }
}
