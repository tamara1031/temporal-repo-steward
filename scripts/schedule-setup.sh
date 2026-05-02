#!/usr/bin/env bash
# Idempotent installer for the Temporal Schedule that drives this platform.
#
# Required env:
#   TEMPORAL_ADDRESS    e.g. temporal-frontend.temporal.svc.cluster.local:7233
#   TEMPORAL_NAMESPACE  e.g. default
#   AGENT_REPO          e.g. tamara1031/temporal-repo-steward
#
# Optional env:
#   AGENT_BASE_BRANCH   default: main
#   AGENT_TASK_QUEUE    default: repo-steward
#   PERIODIC_CRON       default: "0 * * * *"  (hourly)
#
set -euo pipefail

: "${TEMPORAL_ADDRESS:?TEMPORAL_ADDRESS is required}"
: "${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is required}"
: "${AGENT_REPO:?AGENT_REPO is required (owner/repo form)}"

BASE_BRANCH="${AGENT_BASE_BRANCH:-main}"
TASK_QUEUE="${AGENT_TASK_QUEUE:-repo-steward}"
PERIODIC_CRON="${PERIODIC_CRON:-0 * * * *}"

REPO_SAFE="${AGENT_REPO//\//__}"
PERIODIC_SCHED_ID="periodic-refactor-${REPO_SAFE}"

common_args=(
  --address "$TEMPORAL_ADDRESS"
  --namespace "$TEMPORAL_NAMESPACE"
)

periodic_input=$(printf '{"repoFullName":"%s","baseBranch":"%s"}' "$AGENT_REPO" "$BASE_BRANCH")

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

echo ">> done"
