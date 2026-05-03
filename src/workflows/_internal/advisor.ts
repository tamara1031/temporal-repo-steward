/**
 * Workflow-side advisor protocol.
 *
 * Three call sites (pr-lifecycle's pre-self-heal gate, pr-lifecycle's
 * no-diff escalation, periodic's critical_block gate) used to share the
 * same boilerplate: budget check → consume → call the activity → log →
 * swallow exceptions to a deterministic default. This file centralizes that
 * protocol; call sites supply only the {situation, summary, options} payload
 * and interpret the returned verdict for their specific branch.
 *
 * Important contract notes (mirrored in docs/architecture.md):
 *  - **Budget is consumed BEFORE the activity is awaited.** A failing
 *    advisor still counts. This is deliberate: it bounds cost on partial
 *    failures and prevents an exception loop from burning through budget.
 *  - **`undefined` ≡ "no advice available"** (budget exhausted, activity
 *    threw, or `AdvisorOutputInvalid`). Call sites map this to their
 *    safe default — typically the same path as if the advisor had not been
 *    wired in at all.
 *  - **Verdict is returned raw**, not pre-mapped. Different gates legitimately
 *    interpret the same verdict differently (e.g. pr-lifecycle treats
 *    `change-strategy` as continue; periodic treats `retry` as downgrade).
 */

import { log } from '@temporalio/workflow';
import { advisor as advisorProxy } from '../proxies';
import type { ConsultAdvisorOutput } from '../../activities';

/** Workflow-local hard cap on advisor consultations. */
export class AdvisorBudget {
  private consumed = 0;
  constructor(private readonly cap: number) {}
  canConsume(): boolean {
    return this.consumed < this.cap;
  }
  /** Returns false when the cap is already reached (no-op call). */
  tryConsume(): boolean {
    if (!this.canConsume()) return false;
    this.consumed += 1;
    return true;
  }
  used(): number {
    return this.consumed;
  }
  cap_(): number {
    return this.cap;
  }
}

export interface AdvisorRequest {
  workdir: string;
  /** One-line description of the decision gate. */
  situation: string;
  /** Pre-condensed summary for the advisor to reason over (≤ 2 KiB). */
  summary: string;
  /** Concrete options the workflow is choosing between. */
  options?: string[];
}

/**
 * Audit trail of an advisor consultation, intended for the PR body / logs.
 * Surface the rationale and suggested action even when the workflow proceeds
 * with its default — that's the visibility lever the operator needs to
 * decide whether to lift caps next time.
 */
export interface AdvisorAuditEntry {
  /** Which gate triggered the consult. Free-form string the caller chooses. */
  gate: string;
  situation: string;
  /** undefined when the advisor was not consulted (budget) or the call failed. */
  reply?: ConsultAdvisorOutput;
  /** Surfaced when the activity threw — always omitted on success. */
  error?: string;
}

/**
 * Run one advisor consult, honoring the workflow's budget. Returns the raw
 * activity reply (the caller maps the verdict), or `undefined` when no
 * consult happened (budget exhausted or activity error). The third return
 * `audit` lets the caller persist the consultation in the workflow's report.
 */
export async function consultAdvisor(
  budget: AdvisorBudget,
  gate: string,
  req: AdvisorRequest,
): Promise<{ reply?: ConsultAdvisorOutput; audit: AdvisorAuditEntry }> {
  if (!budget.tryConsume()) {
    log.info('advisor budget exhausted; skipping consult', { gate });
    return {
      audit: { gate, situation: req.situation },
    };
  }
  try {
    const reply = await advisorProxy.consultAdvisorActivity({
      workdir: req.workdir,
      situation: req.situation,
      summary: req.summary,
      options: req.options,
    });
    log.info('advisor verdict', {
      gate,
      verdict: reply.verdict,
      rationale: reply.rationale,
      suggestedAction: reply.suggestedAction,
    });
    return { reply, audit: { gate, situation: req.situation, reply } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('advisor consult failed; using caller default', { gate, err: message });
    return { audit: { gate, situation: req.situation, error: message } };
  }
}
