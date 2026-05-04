import type { PlanOutput, PlanStep } from '../../activities/refactor';
import { arraysEqual } from './porcelain';

export function planStepsEqual(a: readonly PlanStep[], b: readonly PlanStep[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa.title !== sb.title || sa.description !== sb.description) return false;
    if (!arraysEqual(sa.critical_requirements, sb.critical_requirements)) return false;

    const ta = sa.target_files;
    const tb = sb.target_files;
    if (ta === undefined || tb === undefined) {
      if (ta !== tb) return false;
    } else if (!arraysEqual(ta, tb)) {
      return false;
    }
  }
  return true;
}

export function plansEqual(a: PlanOutput, b: PlanOutput): boolean {
  return a.theme === b.theme && a.rationale === b.rationale && planStepsEqual(a.steps, b.steps);
}
