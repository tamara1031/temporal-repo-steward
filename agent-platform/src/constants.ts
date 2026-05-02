export const TASK_QUEUE = 'agent-platform';

export const ISSUE_LABEL_AI_READY = 'ai-ready';
export const ISSUE_LABEL_STATUS_PREFIX = 'ai-status:';
export const ISSUE_STATUSES = ['started', 'pr_created', 'done', 'failed'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
