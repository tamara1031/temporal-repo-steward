package workflow

import (
	"fmt"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"go.temporal.io/sdk/workflow"
)

const maxDesignRounds = 2

// DesignPhaseInput is the input to DesignPhaseWorkflow.
type DesignPhaseInput struct {
	SessionID  string
	Repo       string
	BaseBranch string
	Brief      string
}

// DesignPhaseResult is the result of DesignPhaseWorkflow.
type DesignPhaseResult struct {
	SessionID       string
	Plan            codexact.Plan
	ContextArtifact string
	WorkDir         string
	Branch          string
	Skipped         bool
	SkipReason      string
}

// DesignPhaseWorkflow generates a refactoring plan and refines it through review rounds.
func DesignPhaseWorkflow(ctx workflow.Context, in DesignPhaseInput) (DesignPhaseResult, error) {
	var acts *codexact.Activities

	var designResult codexact.DesignResult
	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, codexActivityOpts()),
		acts.DesignActivity,
		codexact.DesignInput{
			SessionID:  in.SessionID,
			Repo:       in.Repo,
			BaseBranch: in.BaseBranch,
			Brief:      in.Brief,
		},
	).Get(ctx, &designResult); err != nil {
		return DesignPhaseResult{}, fmt.Errorf("design: %w", err)
	}

	if len(designResult.Plan.Steps) == 0 {
		return DesignPhaseResult{
			SessionID:  designResult.SessionID,
			Skipped:    true,
			SkipReason: "planner returned no steps",
		}, nil
	}

	plan := designResult.Plan
	sessionID := designResult.SessionID
	contextArtifact := designResult.ContextArtifact

	for round := 0; round < maxDesignRounds; round++ {
		var reviewResult codexact.ReviewResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, reviewActivityOpts()),
			acts.ReviewActivity,
			codexact.ReviewInput{
				SessionID:       sessionID,
				Concern:         "design",
				ContextArtifact: contextArtifact,
			},
		).Get(ctx, &reviewResult); err != nil {
			break
		}

		if reviewResult.Verdict == "ok" {
			break
		}
		if reviewResult.Verdict == "critical_block" {
			return DesignPhaseResult{
				Skipped:    true,
				SkipReason: "design review critical_block: " + reviewResult.Feedback,
			}, nil
		}

		var refineResult codexact.ChatResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, reviewActivityOpts()),
			acts.ChatActivity,
			codexact.ChatInput{
				SessionID: sessionID,
				Message: fmt.Sprintf(
					"Refine the plan based on this feedback: %s\n\n"+
						"Respond with JSON only matching this exact shape:\n"+
						`{"theme":"<one-line summary>","steps":[{"title":"<title>","description":"<what to do>"},...]}`,
					reviewResult.Feedback,
				),
				Context: contextArtifact,
			},
		).Get(ctx, &refineResult); err != nil {
			break
		}
		var refined codexact.Plan
		if codexact.ExtractJSON(refineResult.Response, &refined) == nil && len(refined.Steps) > 0 {
			plan = refined
		} else if refined.Theme != "" {
			plan.Theme = refined.Theme
		}
	}

	return DesignPhaseResult{
		SessionID:       sessionID,
		Plan:            plan,
		ContextArtifact: contextArtifact,
		WorkDir:         designResult.WorkDir,
		Branch:          designResult.Branch,
	}, nil
}
