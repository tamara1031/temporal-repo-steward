/**
 * advisor/ cluster — escalation hop to a stronger model when the workflow is
 * stuck or about to take a costly / destructive action. Single activity by
 * design; do not let it grow into a generic LLM gateway.
 */

export { consultAdvisorActivity } from './advisor';
export type {
  ConsultAdvisorInput,
  ConsultAdvisorOutput,
  AdvisorVerdict,
} from './advisor';
