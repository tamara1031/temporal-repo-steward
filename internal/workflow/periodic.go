package workflow

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const maxStepsPerRun = 2

// PeriodicRefactorInput is the input to PeriodicRefactorWorkflow.
type PeriodicRefactorInput struct {
	RepoFullName string
	BaseBranch   string
	Brief        string
	PRTitle      string
	PRBody       string
	AutoMerge    bool
}

// PeriodicRefactorResult is the result of PeriodicRefactorWorkflow.
type PeriodicRefactorResult struct {
	SessionID  string
	StepsDone  int
	PRNumber   int
	PRURL      string
	PROutcome  string
	Skipped    bool
	SkipReason string
}

// PeriodicRefactorWorkflow runs a full design → implement → PR cycle.
func PeriodicRefactorWorkflow(ctx workflow.Context, in PeriodicRefactorInput) (PeriodicRefactorResult, error) {
	childOpts := workflow.ChildWorkflowOptions{
		WorkflowExecutionTimeout: 3 * time.Hour,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 1,
		},
	}

	var designResult DesignPhaseResult
	if err := workflow.ExecuteChildWorkflow(
		workflow.WithChildOptions(ctx, childOpts),
		DesignPhaseWorkflow,
		DesignPhaseInput{
			Repo:       in.RepoFullName,
			BaseBranch: in.BaseBranch,
			Brief:      in.Brief,
		},
	).Get(ctx, &designResult); err != nil {
		return PeriodicRefactorResult{}, fmt.Errorf("design phase: %w", err)
	}
	if designResult.Skipped {
		return PeriodicRefactorResult{
			SessionID:  designResult.SessionID,
			Skipped:    true,
			SkipReason: designResult.SkipReason,
		}, nil
	}

	sessionID := designResult.SessionID
	contextArtifact := designResult.ContextArtifact
	workDir := designResult.WorkDir
	branch := designResult.Branch
	steps := designResult.Plan.Steps

	limit := maxStepsPerRun
	if len(steps) < limit {
		limit = len(steps)
	}

	stepsDone := 0
	for i := 0; i < limit; i++ {
		var stepResult RefactorStepResult
		if err := workflow.ExecuteChildWorkflow(
			workflow.WithChildOptions(ctx, childOpts),
			RefactorStepWorkflow,
			RefactorStepInput{
				SessionID:       sessionID,
				Step:            steps[i],
				ContextArtifact: contextArtifact,
			},
		).Get(ctx, &stepResult); err != nil {
			break
		}
		if stepResult.Kind == "circuit-broken" {
			break
		}
		stepsDone++
	}

	if stepsDone == 0 {
		return PeriodicRefactorResult{
			SessionID:  sessionID,
			Skipped:    true,
			SkipReason: "no steps completed successfully",
		}, nil
	}

	var prResult RobustPRMergeResult
	if err := workflow.ExecuteChildWorkflow(
		workflow.WithChildOptions(ctx, childOpts),
		RobustPRMergeWorkflow,
		RobustPRMergeInput{
			RepoFullName: in.RepoFullName,
			WorkDir:      workDir,
			Branch:       branch,
			BaseBranch:   in.BaseBranch,
			PRTitle:      in.PRTitle,
			PRBody:       fmt.Sprintf("%s\n\n_%d of %d planned steps applied._", in.PRBody, stepsDone, len(steps)),
			SessionID:    sessionID,
			AutoMerge:    in.AutoMerge,
		},
	).Get(ctx, &prResult); err != nil {
		return PeriodicRefactorResult{
			SessionID: sessionID,
			StepsDone: stepsDone,
		}, fmt.Errorf("PR lifecycle: %w", err)
	}

	return PeriodicRefactorResult{
		SessionID: sessionID,
		StepsDone: stepsDone,
		PRNumber:  prResult.PRNumber,
		PRURL:     prResult.PRURL,
		PROutcome: prResult.Outcome,
	}, nil
}
