package workflow

import (
	"fmt"
	"log/slog"
	"time"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
	ghact "github.com/tamara1031/temporal-repo-steward/internal/activity/github"
	rserrors "github.com/tamara1031/temporal-repo-steward/internal/errors"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	maxFixIterations      = 8
	postMergePollAttempts = 6
)

// QueryCIProgress is the query name for CIProgress.
const QueryCIProgress = "ci_progress"

// CIProgress is the payload returned by the "ci_progress" query handler on
// RobustPRMergeWorkflow. It lets operators track which CI self-heal iteration
// is in flight and what the last observed CI outcome was.
type CIProgress struct {
	PRNumber      int    `json:"pr_number"`
	PRURL         string `json:"pr_url"`
	Iteration     int    `json:"iteration"`
	MaxIterations int    `json:"max_iterations"`
	LastOutcome   string `json:"last_outcome,omitempty"`
}

// RobustPRMergeInput is the input to RobustPRMergeWorkflow.
type RobustPRMergeInput struct {
	RepoFullName string
	WorkDir      string
	Branch       string
	BaseBranch   string
	PRTitle      string
	PRBody       string
	SessionID    string
	AutoMerge    bool
}

// RobustPRMergeResult is the result of RobustPRMergeWorkflow.
type RobustPRMergeResult struct {
	PRNumber int
	PRURL    string
	Merged   bool
	Outcome  string // "merged" | "merge-queued" | "closed-externally" | "auto-merge-disabled"
}

// RobustPRMergeWorkflow creates a PR, waits for CI, self-heals failures, and merges.
func RobustPRMergeWorkflow(ctx workflow.Context, in RobustPRMergeInput) (RobustPRMergeResult, error) {
	ciProgress := CIProgress{MaxIterations: maxFixIterations}
	if err := workflow.SetQueryHandler(ctx, QueryCIProgress, func() (CIProgress, error) {
		return ciProgress, nil
	}); err != nil {
		return RobustPRMergeResult{}, fmt.Errorf("register ci_progress query: %w", err)
	}

	cheapOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
		},
	}
	heavyOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    4,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    5 * time.Minute,
		},
	}
	ciWaitOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 70 * time.Minute,
		HeartbeatTimeout:    60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	codexOpts := workflow.ActivityOptions{
		StartToCloseTimeout: 35 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 3,
			MaximumInterval:    10 * time.Minute,
		},
	}

	var ghActs *ghact.Activities
	var gitActs *gitact.Activities
	var codexActs *codexact.Activities

	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, heavyOpts),
		gitActs.PushBranchActivity,
		gitact.PushInput{WorkDir: in.WorkDir, Branch: in.Branch},
	).Get(ctx, nil); err != nil {
		return RobustPRMergeResult{}, fmt.Errorf("push: %w", err)
	}

	var prResult ghact.CreatePRResult
	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, cheapOpts),
		ghActs.CreatePRActivity,
		ghact.CreatePRInput{
			WorkDir:    in.WorkDir,
			Title:      in.PRTitle,
			Body:       in.PRBody,
			BaseBranch: in.BaseBranch,
			Branch:     in.Branch,
		},
	).Get(ctx, &prResult); err != nil {
		return RobustPRMergeResult{}, fmt.Errorf("create PR: %w", err)
	}

	result := RobustPRMergeResult{
		PRNumber: prResult.Number,
		PRURL:    prResult.URL,
	}

	ciProgress.PRNumber = prResult.Number
	ciProgress.PRURL = prResult.URL

	for iteration := 0; iteration < maxFixIterations; iteration++ {
		ciProgress.Iteration = iteration

		var ciResult ghact.WaitForCIResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, ciWaitOpts),
			ghActs.WaitForCIActivity,
			ghact.WaitForCIInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
		).Get(ctx, &ciResult); err != nil {
			return result, err
		}

		ciProgress.LastOutcome = string(ciResult.Outcome)

		switch ciResult.Outcome {
		case ghact.CIOutcomeExternallyMerged:
			result.Outcome = "merged-externally"
			result.Merged = true
			return result, nil
		case ghact.CIOutcomeExternallyClosed:
			result.Outcome = "closed-externally"
			return result, nil
		case ghact.CIOutcomeSuccess:
			if !in.AutoMerge {
				result.Outcome = "auto-merge-disabled"
				return result, nil
			}
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, cheapOpts),
				ghActs.MergePRActivity,
				ghact.MergePRInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
			).Get(ctx, nil); err != nil {
				return result, fmt.Errorf("merge: %w", err)
			}
			var finalOutcome ghact.CIOutcome
			_ = workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, cheapOpts),
				ghActs.ObservePRStateActivity,
				ghact.ObservePRStateInput{WorkDir: in.WorkDir, PRNumber: prResult.Number, Attempts: postMergePollAttempts},
			).Get(ctx, &finalOutcome)
			result.Merged = true
			result.Outcome = string(finalOutcome)
			return result, nil
		case ghact.CIOutcomeFailure:
			if iteration == maxFixIterations-1 {
				return result, rserrors.NewMaxIterations()
			}
			slog.Info("CI failed, attempting self-heal", "iteration", iteration)

			var failLogs string
			_ = workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, cheapOpts),
				ghActs.FetchFailedRunLogsActivity,
				ghact.FetchFailedRunLogsInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
			).Get(ctx, &failLogs)

			var fixResult codexact.ChatResult
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, codexOpts),
				codexActs.ChatActivity,
				codexact.ChatInput{
					SessionID: in.SessionID,
					Message:   fmt.Sprintf("Fix this CI failure. Apply the fix to the files in the working directory.\n\nFailed CI logs:\n%s", failLogs),
				},
			).Get(ctx, &fixResult); err != nil {
				continue
			}

			var commitSHA string
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, cheapOpts),
				gitActs.CommitAllActivity,
				gitact.CommitAllInput{WorkDir: in.WorkDir, Message: fmt.Sprintf("fix: CI self-heal (iteration %d)", iteration+1)},
			).Get(ctx, &commitSHA); err != nil {
				return result, rserrors.NewNoFixDiff()
			}
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, heavyOpts),
				gitActs.PushBranchActivity,
				gitact.PushInput{WorkDir: in.WorkDir, Branch: in.Branch, Force: true},
			).Get(ctx, nil); err != nil {
				return result, fmt.Errorf("push fix: %w", err)
			}
		}
	}

	return result, rserrors.NewMaxIterations()
}
