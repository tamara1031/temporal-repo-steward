package workflow

import (
	"fmt"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"go.temporal.io/sdk/workflow"
)

const maxDesignRounds = 2

// DesignPhaseInput is the input to DesignPhaseWorkflow.
type DesignPhaseInput struct {
	// SessionID pins the workspace to a caller-chosen identity. When empty,
	// the workflow derives one from its own RunID so retried activities reuse
	// the same workspace rather than spawning a fresh clone each attempt.
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
	// Derive a stable session ID from the workflow RunID so that activity
	// retries reuse the same cloned workspace instead of creating orphaned ones.
	sessionID := in.SessionID
	if sessionID == "" {
		sessionID = workflow.GetInfo(ctx).WorkflowExecution.RunID
	}

	var acts *codexact.Activities

	var designResult codexact.DesignResult
	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, shortActOpts()),
		acts.DesignActivity,
		codexact.DesignInput{
			SessionID:  sessionID,
			Repo:       in.Repo,
			BaseBranch: in.BaseBranch,
			Brief:      in.Brief,
		},
	).Get(ctx, &designResult); err != nil {
		return DesignPhaseResult{}, fmt.Errorf("design: %w", err)
	}

	if len(designResult.Plan.Steps) == 0 {
		return DesignPhaseResult{
			SessionID:  sessionID,
			Skipped:    true,
			SkipReason: "planner returned no steps",
		}, nil
	}

	plan := designResult.Plan
	contextArtifact := designResult.ContextArtifact

	for round := 0; round < maxDesignRounds; round++ {
		var reviewResult codexact.ReviewResult
		if err := workflow.ExecuteActivity(
			workflow.WithActivityOptions(ctx, shortActOpts()),
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
			workflow.WithActivityOptions(ctx, shortActOpts()),
			acts.ChatActivity,
			codexact.ChatInput{
				SessionID: sessionID,
				Message: fmt.Sprintf(
					"Refine the plan based on this feedback: %s\n\n"+
						"Respond with JSON only matching this exact shape:\n"+
						`{"theme":"<one-line summary>","steps":[{"title":"<title>","description":"<what to do>"},...]}`,
					reviewResult.Feedback,
				),
				ContextArtifact: contextArtifact,
			},
		).Get(ctx, &refineResult); err != nil {
			break
		}
		if refined := parsePlan(refineResult.Response); len(refined.Steps) > 0 {
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

// parsePlan extracts the first JSON object from raw and unmarshals it as a Plan.
// Returns a zero Plan (empty Steps) when no valid JSON is found.
func parsePlan(raw string) codexact.Plan {
	var p codexact.Plan
	if err := codexact.ExtractJSON(raw, &p); err != nil {
		return codexact.Plan{}
	}
	return p
}
