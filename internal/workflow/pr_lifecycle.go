package workflow

import (
	"fmt"
	"log/slog"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
	ghact "github.com/tamara1031/temporal-repo-steward/internal/activity/github"
	rserrors "github.com/tamara1031/temporal-repo-steward/internal/errors"
	"go.temporal.io/sdk/workflow"
)

const (
	maxFixIterations     = 8
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

// MergeOutcome classifies the terminal state of a RobustPRMergeWorkflow execution.
type MergeOutcome string

const (
	MergeOutcomeMerged             MergeOutcome = "merged"
	MergeOutcomeMergeQueued        MergeOutcome = "merge-queued"
	MergeOutcomeExternallyClosed   MergeOutcome = "closed-externally"
	MergeOutcomeExternallyMerged   MergeOutcome = "merged-externally"
	MergeOutcomeAutoMergeDisabled  MergeOutcome = "auto-merge-disabled"
)

// RobustPRMergeResult is the result of RobustPRMergeWorkflow.
type RobustPRMergeResult struct {
	PRNumber int
	PRURL    string
	Merged   bool
	Outcome  MergeOutcome
}

// RobustPRMergeWorkflow creates a PR, waits for CI, self-heals failures, and merges.
func RobustPRMergeWorkflow(ctx workflow.Context, in RobustPRMergeInput) (RobustPRMergeResult, error) {
	ciProgress := CIProgress{MaxIterations: maxFixIterations}
	if err := workflow.SetQueryHandler(ctx, QueryCIProgress, func() (CIProgress, error) {
		return ciProgress, nil
	}); err != nil {
		return RobustPRMergeResult{}, fmt.Errorf("register ci_progress query: %w", err)
	}

	var ghActs *ghact.Activities
	var gitActs *gitact.Activities
	var codexActs *codexact.Activities

	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, heavyGitActOpts()),
		gitActs.PushBranchActivity,
		gitact.PushInput{WorkDir: in.WorkDir, Branch: in.Branch},
	).Get(ctx, nil); err != nil {
		return RobustPRMergeResult{}, fmt.Errorf("push: %w", err)
	}

	var prResult ghact.CreatePRResult
	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, fastGHActOpts()),
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
			workflow.WithActivityOptions(ctx, ciPollActOpts()),
			ghActs.WaitForCIActivity,
			ghact.WaitForCIInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
		).Get(ctx, &ciResult); err != nil {
			return result, err
		}

		ciProgress.LastOutcome = string(ciResult.Outcome)

		switch ciResult.Outcome {
		case ghact.CIOutcomeExternallyMerged:
			result.Outcome = MergeOutcomeExternallyMerged
			result.Merged = true
			return result, nil
		case ghact.CIOutcomeExternallyClosed:
			result.Outcome = MergeOutcomeExternallyClosed
			return result, nil
		case ghact.CIOutcomeMergeQueued:
			result.Outcome = MergeOutcomeMergeQueued
			result.Merged = true
			return result, nil
		case ghact.CIOutcomeSuccess:
			if !in.AutoMerge {
				result.Outcome = MergeOutcomeAutoMergeDisabled
				return result, nil
			}
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, fastGHActOpts()),
				ghActs.MergePRActivity,
				ghact.MergePRInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
			).Get(ctx, nil); err != nil {
				return result, fmt.Errorf("merge: %w", err)
			}
			var finalOutcome ghact.CIOutcome
			_ = workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, fastGHActOpts()),
				ghActs.ObservePRStateActivity,
				ghact.ObservePRStateInput{WorkDir: in.WorkDir, PRNumber: prResult.Number, Attempts: postMergePollAttempts},
			).Get(ctx, &finalOutcome)
			result.Merged = true
			result.Outcome = ciOutcomeToMerge(finalOutcome)
			return result, nil
		case ghact.CIOutcomeFailure:
			if iteration == maxFixIterations-1 {
				return result, rserrors.NewMaxIterations()
			}
			slog.Info("CI failed, attempting self-heal", "iteration", iteration)

			var failLogs string
			_ = workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, fastGHActOpts()),
				ghActs.FetchFailedRunLogsActivity,
				ghact.FetchFailedRunLogsInput{
					WorkDir:       in.WorkDir,
					PRNumber:      prResult.Number,
					FailedRunURLs: ciResult.FailedRuns,
				},
			).Get(ctx, &failLogs)

			var fixResult codexact.ChatResult
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, longCodexActOpts()),
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
				workflow.WithActivityOptions(ctx, fastGHActOpts()),
				gitActs.CommitAllActivity,
				gitact.CommitAllInput{WorkDir: in.WorkDir, Message: fmt.Sprintf("fix: CI self-heal (iteration %d)", iteration+1)},
			).Get(ctx, &commitSHA); err != nil {
				return result, rserrors.NewNoFixDiff()
			}
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, heavyGitActOpts()),
				gitActs.PushBranchActivity,
				gitact.PushInput{WorkDir: in.WorkDir, Branch: in.Branch, Force: true},
			).Get(ctx, nil); err != nil {
				return result, fmt.Errorf("push fix: %w", err)
			}
		}
	}

	return result, rserrors.NewMaxIterations()
}

// ciOutcomeToMerge maps a post-merge CIOutcome observation to a MergeOutcome.
// ObservePRStateActivity returns CIOutcomeSuccess when the PR is confirmed
// merged, CIOutcomeExternallyClosed when it was closed instead, and
// CIOutcomeMergeQueued when it is still in the merge queue after all attempts.
func ciOutcomeToMerge(o ghact.CIOutcome) MergeOutcome {
	switch o {
	case ghact.CIOutcomeExternallyClosed:
		return MergeOutcomeExternallyClosed
	case ghact.CIOutcomeMergeQueued:
		return MergeOutcomeMergeQueued
	default:
		return MergeOutcomeMerged
	}
}
