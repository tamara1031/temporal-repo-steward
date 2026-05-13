package workflow

import (
	"fmt"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	rserrors "github.com/tamara1031/temporal-repo-steward/internal/errors"
	"go.temporal.io/sdk/workflow"
)

const maxStepIter = 2

// StepKind is the outcome category of a RefactorStepWorkflow execution.
type StepKind string

const (
	StepCompleted     StepKind = "completed"
	StepBudgetHalted  StepKind = "budget-halted"
	StepCircuitBroken StepKind = "circuit-broken"
)

// RefactorStepInput is the input to RefactorStepWorkflow.
type RefactorStepInput struct {
	SessionID       string
	Step            codexact.Step
	ContextArtifact string
}

// RefactorStepResult is the result of RefactorStepWorkflow.
type RefactorStepResult struct {
	Kind      StepKind
	CommitSHA string
}

// RefactorStepWorkflow implements a single refactoring step with iterative review.
func RefactorStepWorkflow(ctx workflow.Context, in RefactorStepInput) (RefactorStepResult, error) {
	var acts *codexact.Activities

	for iter := 0; iter < maxStepIter; iter++ {
		var implResult codexact.ImplementResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, longCodexActOpts()),
			acts.ImplementActivity,
			codexact.ImplementInput{
				SessionID:       in.SessionID,
				Step:            in.Step,
				ContextArtifact: in.ContextArtifact,
			},
		).Get(ctx, &implResult); err != nil {
			return RefactorStepResult{Kind: StepCircuitBroken}, err
		}

		if !implResult.HasChanges {
			return RefactorStepResult{Kind: StepCircuitBroken}, fmt.Errorf("implement produced no changes")
		}

		blocked := false
		for _, concern := range []codexact.ReviewConcern{codexact.ConcernCorrectness, codexact.ConcernQuality} {
			var reviewResult codexact.ReviewResult
			if err := workflow.ExecuteActivity(
				workflow.WithActivityOptions(ctx, shortActOpts()),
				acts.ReviewActivity,
				codexact.ReviewInput{
					SessionID:       in.SessionID,
					Concern:         concern,
					ContextArtifact: in.ContextArtifact,
				},
			).Get(ctx, &reviewResult); err != nil {
				continue
			}

			if reviewResult.Verdict == codexact.VerdictCriticalBlock {
				if iter == maxStepIter-1 {
					advisorSummary := fmt.Sprintf("Step: %s\nConcern: %s\nFeedback: %s", in.Step.Title, concern, reviewResult.Feedback)
					var verdict codexact.AdvisorVerdict
					if err := workflow.ExecuteActivity(
						workflow.WithActivityOptions(ctx, shortActOpts()),
						acts.ConsultAdvisorActivity,
						advisorSummary,
					).Get(ctx, &verdict); err == nil && verdict.Verdict == codexact.AdvisorVerdictAbort {
						return RefactorStepResult{Kind: StepCircuitBroken}, rserrors.AdvisorAbort(verdict.Rationale)
					}
				}
				blocked = true
				break
			}
		}

		if !blocked {
			return RefactorStepResult{
				Kind:      StepCompleted,
				CommitSHA: implResult.CommitSHA,
			}, nil
		}
	}

	return RefactorStepResult{Kind: StepBudgetHalted}, nil
}
