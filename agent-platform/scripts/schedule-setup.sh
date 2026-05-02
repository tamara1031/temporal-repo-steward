#!/usr/bin/env bash
# Idempotent installer for the Temporal Schedules that drive this platform.
#
# Required env:
#   TEMPORAL_ADDRESS    e.g. temporal-frontend.temporal.svc.cluster.local:7233
#   TEMPORAL_NAMESPACE  e.g. default
#   AGENT_REPO          e.g. yamato/temporal-homelab
#
# Optional env:
#   AGENT_BASE_BRANCH   default: main
#   AGENT_TASK_QUEUE    default: agent-platform
#   PERIODIC_CRON       default: "0 * * * *"  (hourly)
#   ISSUE_POLL_INTERVAL default: "5m"
#
set -euo pipefail

: "${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS is required}"
: "${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is required}"
: "${AGENT_REPO:?AGENT_REPO is required (owner/repo form)}"

BASE_BRANCH="${AGENT_BASE_BRANCH:-main}"
TASK_QUEUE="${AGENT_TASK_QUEUE:-agent-platform}"
PERIODIC_CRON="${PERIODIC_CRON:-0 * * * *}"
ISSUE_POLL_INTERVAL="${ISSUE_POLL_INTERVAL:-5m}"

REPO_SAFE="${AGENT_REPO//\//__}"
PERIODIC_SCHED_ID="periodic-refactor-${REPO_SAFE}"
ISSUE_SCHED_ID="issue-poller-${REPO_SAFE}"

common_args=(
  --address "$TEMPORAL_ADDRESS"
  --namespace "$TEMPORAL_NAMESPACE"
)

periodic_input=$(printf '{"repoFullName":"%s","baseBranch":"%s"}' "$AGENT_REPO" "$BASE_BRANCH")
issue_input=$(printf '{"repoFullName":"%s","baseBranch":"%s","taskQueue":"%s"}' \
  "$AGENT_REPO" "$BASE_BRANCH" "$TASK_QUEUE")

echo ">> upserting schedule: $PERIODIC_SCHED_ID"
temporal schedule create "${common_args[@]}" \
  --schedule-id "$PERIODIC_SCHED_ID" \
  --workflow-id "$PERIODIC_SCHED_ID" \
  --workflow-type "periodicRefactorWorkflow" \
  --task-queue "$TASK_QUEUE" \
  --cron "$PERIODIC_CRON" \
  --overlap-policy Skip \
  --input "$periodic_input" \
  --upsert

echo ">> upserting schedule: $ISSUE_SCHED_ID"
temporal schedule create "${common_args[@]}" \
  --schedule-id "$ISSUE_SCHED_ID" \
  --workflow-id "$ISSUE_SCHED_ID" \
  --workflow-type "issuePollerWorkflow" \
  --task-queue "$TASK_QUEUE" \
  --interval "$ISSUE_POLL_INTERVAL" \
  --overlap-policy Skip \
  --input "$issue_input" \
  --upsert

echo ">> done"
