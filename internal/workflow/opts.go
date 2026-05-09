package workflow

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// codexActivityOpts returns options for long-running Codex AI invocations (design, implement).
func codexActivityOpts() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: 35 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 3,
			MaximumInterval:    10 * time.Minute,
		},
	}
}

// reviewActivityOpts returns options for shorter Codex review and chat calls.
func reviewActivityOpts() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 3,
			MaximumInterval:    10 * time.Minute,
		},
	}
}

// cheapActivityOpts returns options for fast, idempotent GitHub API calls.
func cheapActivityOpts() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
		},
	}
}

// heavyActivityOpts returns options for git push and other network-heavy operations.
func heavyActivityOpts() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    4,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    5 * time.Minute,
		},
	}
}

// ciWaitActivityOpts returns options for the long-polling CI status activity.
func ciWaitActivityOpts() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: 70 * time.Minute,
		HeartbeatTimeout:    60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
}
