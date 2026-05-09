package workflow

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"go.temporal.io/sdk/temporal"
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
	opts := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts:    5,
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 3,
			MaximumInterval:    10 * time.Minute,
		},
	}

	var acts *codexact.Activities

	var designResult codexact.DesignResult
	if err := workflow.ExecuteActivity(
		workflow.WithActivityOptions(ctx, opts),
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
			workflow.WithActivityOptions(ctx, opts),
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
			workflow.WithActivityOptions(ctx, opts),
			acts.ChatActivity,
			codexact.ChatInput{
				SessionID:       sessionID,
				Message:         fmt.Sprintf("Refine the plan based on this feedback: %s\n\nRespond with JSON only: {\"theme\":\"...\",\"steps\":[{\"title\":\"...\",\"description\":\"...\"}]}", reviewResult.Feedback),
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
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start == -1 || end <= start {
		return codexact.Plan{}
	}
	var p codexact.Plan
	if err := json.Unmarshal([]byte(raw[start:end+1]), &p); err != nil {
		return codexact.Plan{}
	}
	return p
}
