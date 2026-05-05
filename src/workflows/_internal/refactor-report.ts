/**
 * Refactor PR-body renderer.
 *
 * Lives in `_internal/` because it is pure formatting — no Temporal API,
 * no clock, no randomness — but it is only ever consumed by the periodic
 * refactor workflow. Keeping it out of `periodic.ts` lets the orchestrator
 * read top-to-bottom as a sequence of intents instead of mixing string
 * assembly with Activity calls.
 *
 * Domain types (`StepRecord`, `ParliamentSummary`, `CircuitBreaker`) live in
 * `step-types.ts`.  They are re-exported here so existing imports continue to
 * resolve; new code should import directly from `step-types.ts`.
 *
 * Determinism: the function is a pure mapping from `ReportInput` to
 * `string`; safe to import from any workflow file.
 */
import type {
  DesignPhaseRecord,
  PlanOutput,
  PlanStep,
} from '../../activities/refactor';
import type { AdvisorAuditEntry } from './advisor';
import type { CircuitBreaker, StepRecord } from './step-types';

export interface ReportInput {
  plan: PlanOutput;
  droppedFromPlan: PlanStep[];
  stepRecords: StepRecord[];
  circuitBroken?: CircuitBreaker;
  spawnSummary: { total: number; cap: number; perRole: Record<string, number> };
  branch: string;
  advisorAudits: AdvisorAuditEntry[];
  /**
   * The orchestrator's hard cap on plan steps. Passed through so the report
   * can describe the truncation precisely without re-importing the constant.
   */
  stepCap: number;
  /** Design parliament rounds, if any ran. */
  designRecord?: DesignPhaseRecord;
}

interface ReportAccounting {
  plannerStepCount: number;
  renderedSteps: StepRecord[];
  droppedSteps: PlanStep[];
  stepCap: number;
}

function computeReportAccounting(r: ReportInput): ReportAccounting {
  return {
    plannerStepCount: r.plan.steps.length,
    renderedSteps: r.stepRecords,
    droppedSteps: r.droppedFromPlan,
    stepCap: r.stepCap,
  };
}

function shouldRenderStepCapSection(a: ReportAccounting): boolean {
  return a.droppedSteps.length > 0;
}

function renderStepCapSummary(a: ReportAccounting): string {
  return `Planner returned ${a.plannerStepCount} steps; cap is ${a.stepCap}. Dropped:`;
}

export function renderReport(r: ReportInput): string {
  const accounting = computeReportAccounting(r);
  const lines: string[] = [];
  lines.push('## Theme and intent');
  lines.push(`**${r.plan.theme}** — ${r.plan.rationale}`);
  lines.push('');
  if (r.designRecord && r.designRecord.rounds.length > 0) {
    lines.push('## Design parliament');
    lines.push(`Outcome: \`${r.designRecord.outcome}\` (${r.designRecord.iters} round(s))`);
    for (const round of r.designRecord.rounds) {
      lines.push(`### Round ${round.iter}`);
      for (const rv of round.reviews) {
        const tag = `[${rv.concern}: ${rv.verdict}]`;
        if (rv.bullets.length === 0) {
          lines.push(`- ${tag} (no findings)`);
        } else {
          lines.push(`- ${tag}`);
          for (const b of rv.bullets) lines.push(`  - ${b}`);
        }
      }
    }
    lines.push('');
  }
  if (r.circuitBroken) {
    lines.push('## ⛔ Circuit breaker fired');
    lines.push(
      `Reviewer **${r.circuitBroken.concern}** issued \`critical_block\` on step "${r.circuitBroken.step.title}". Working tree restored.`,
    );
    for (const b of r.circuitBroken.bullets) lines.push(`- ${b}`);
    lines.push('');
  }
  lines.push('## Step outcomes');
  for (const rec of accounting.renderedSteps) {
    lines.push(`### Step: ${rec.step.title} — ${rec.outcome} (${rec.iters} iter)`);
    lines.push(rec.step.description);
    lines.push('');
    if (rec.implementReports.length > 0) {
      lines.push('**Implementer report (final iter):**');
      lines.push('');
      lines.push(rec.implementReports[rec.implementReports.length - 1]);
      lines.push('');
    }
    if (rec.parliamentSummary.length > 0) {
      lines.push('**Parliament:**');
      for (const ps of rec.parliamentSummary) {
        if (ps.skipped) {
          lines.push(`- iter ${ps.iter}: skipped (${ps.skipped})`);
          continue;
        }
        for (const rv of ps.reviews) {
          const tag = `[${rv.concern}: ${rv.verdict}]`;
          if (rv.bullets.length === 0) {
            lines.push(`- iter ${ps.iter} ${tag} (no findings)`);
          } else {
            lines.push(`- iter ${ps.iter} ${tag}`);
            for (const b of rv.bullets) lines.push(`  - ${b}`);
          }
        }
      }
      lines.push('');
    }
    if (rec.driftReverts.length > 0) {
      lines.push('**Reviewer drift reverted:**');
      for (const f of rec.driftReverts) lines.push(`- ${f}`);
      lines.push('');
    }
  }
  if (shouldRenderStepCapSection(accounting)) {
    lines.push('## ⚠️ Dropped by step cap');
    lines.push(renderStepCapSummary(accounting));
    for (const s of accounting.droppedSteps) lines.push(`- ${s.title}`);
    lines.push('');
  }
  lines.push('## Spawn budget');
  lines.push(`Used **${r.spawnSummary.total} / ${r.spawnSummary.cap}** codex calls.`);
  for (const [role, n] of Object.entries(r.spawnSummary.perRole)) {
    lines.push(`- ${role}: ${n}`);
  }
  lines.push('');
  if (r.advisorAudits.length > 0) {
    lines.push('## Advisor consults');
    lines.push(
      'The advisor (top-tier model) was consulted at the following decision gates. ' +
        'Verdicts are advisory; the rollback / continue defaults still applied unless ' +
        'the workflow comment notes otherwise.',
    );
    lines.push('');
    for (const a of r.advisorAudits) {
      lines.push(`### Gate: \`${a.gate}\``);
      lines.push(`> ${a.situation}`);
      if (a.reply) {
        lines.push(`- **Verdict**: \`${a.reply.verdict}\``);
        if (a.reply.rationale) lines.push(`- **Rationale**: ${a.reply.rationale}`);
        if (a.reply.suggestedAction) lines.push(`- **Suggested action**: ${a.reply.suggestedAction}`);
      } else if (a.error) {
        lines.push(`- (advisor call failed: ${a.error.slice(0, 200)})`);
      } else {
        lines.push('- (advisor budget exhausted; default path taken)');
      }
      lines.push('');
    }
  }
  lines.push(`*Branch: \`${r.branch}\`. Generated by periodicRefactorWorkflow.*`);
  return lines.join('\n');
}
