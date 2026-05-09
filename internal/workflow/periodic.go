package workflow

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const maxStepsPerRun = 2

// QueryProgress is the query name for RefactorProgress.
const QueryProgress = "progress"

// RefactorPhase identifies the current execution phase of a PeriodicRefactorWorkflow.
type RefactorPhase string

const (
	PhaseDesign    RefactorPhase = "design"
	PhaseImplement RefactorPhase = "implement"
	PhasePR        RefactorPhase = "pr"
	PhaseDone      RefactorPhase = "done"
)

// RefactorProgress is the payload returned by the "progress" query handler on
// PeriodicRefactorWorkflow. It lets operators inspect a long-running cycle in
// real time without parsing logs.
type RefactorProgress struct {
	Phase      RefactorPhase `json:"phase"`
	StepsDone  int           `json:"steps_done"`
	TotalSteps int           `json:"total_steps"`
	PRNumber   int           `json:"pr_number,omitempty"`
	PRURL      string        `json:"pr_url,omitempty"`
	Skipped    bool          `json:"skipped,omitempty"`
	SkipReason string        `json:"skip_reason,omitempty"`
}

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
	PROutcome  MergeOutcome
	Skipped    bool
	SkipReason string
}

// PeriodicRefactorWorkflow runs a full design → implement → PR cycle.
func PeriodicRefactorWorkflow(ctx workflow.Context, in PeriodicRefactorInput) (PeriodicRefactorResult, error) {
	progress := RefactorProgress{Phase: PhaseDesign}
	if err := workflow.SetQueryHandler(ctx, QueryProgress, func() (RefactorProgress, error) {
		return progress, nil
	}); err != nil {
		return PeriodicRefactorResult{}, fmt.Errorf("register progress query: %w", err)
	}

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
		progress.Skipped = true
		progress.SkipReason = designResult.SkipReason
		progress.Phase = PhaseDone
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

	progress.Phase = PhaseImplement
	progress.TotalSteps = limit

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
		if stepResult.Kind == StepKindCircuitBroken {
			break
		}
		stepsDone++
		progress.StepsDone = stepsDone
	}

	if stepsDone == 0 {
		progress.Skipped = true
		progress.SkipReason = "no steps completed successfully"
		progress.Phase = PhaseDone
		return PeriodicRefactorResult{
			SessionID:  sessionID,
			Skipped:    true,
			SkipReason: "no steps completed successfully",
		}, nil
	}

	progress.Phase = PhasePR

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
		progress.Phase = PhaseDone
		return PeriodicRefactorResult{
			SessionID: sessionID,
			StepsDone: stepsDone,
		}, fmt.Errorf("PR lifecycle: %w", err)
	}

	progress.PRNumber = prResult.PRNumber
	progress.PRURL = prResult.PRURL
	progress.Phase = PhaseDone

	return PeriodicRefactorResult{
		SessionID: sessionID,
		StepsDone: stepsDone,
		PRNumber:  prResult.PRNumber,
		PRURL:     prResult.PRURL,
		PROutcome: prResult.Outcome,
	}, nil
}
