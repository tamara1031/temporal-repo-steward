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
	maxFixIterations      = 8
	postMergePollAttempts = 6
)

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

	for iteration := 0; iteration < maxFixIterations; iteration++ {
		var ciResult ghact.WaitForCIResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, ciPollActOpts()),
			ghActs.WaitForCIActivity,
			ghact.WaitForCIInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
		).Get(ctx, &ciResult); err != nil {
			return result, err
		}

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
			result.Outcome = string(finalOutcome)
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
				ghact.FetchFailedRunLogsInput{WorkDir: in.WorkDir, PRNumber: prResult.Number},
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
