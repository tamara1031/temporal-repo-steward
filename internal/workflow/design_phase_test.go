package workflow_test

import (
	"fmt"
	"testing"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"
)

type designPhaseSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
}

func TestDesignPhaseSuite(t *testing.T) {
	suite.Run(t, new(designPhaseSuite))
}

func (s *designPhaseSuite) Test_SkipsWhenNoSteps() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID: "test-session-00000001",
			Plan:      codexact.Plan{Theme: "theme", Steps: nil},
			WorkDir:   "/tmp/ws",
			Branch:    "codex-session/test",
		}, nil)

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo:       "owner/repo",
		BaseBranch: "main",
		Brief:      "test brief",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.DesignPhaseResult
	s.NoError(env.GetWorkflowResult(&result))
	s.True(result.Skipped)
	s.Equal("planner returned no steps", result.SkipReason)
}

func (s *designPhaseSuite) Test_HappyPath_ReviewOK() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID:       "test-session-00000001",
			Plan:            codexact.Plan{Theme: "theme", Steps: []codexact.Step{{Title: "step1", Description: "do it"}}},
			WorkDir:         "/tmp/ws",
			Branch:          "codex-session/test",
			ContextArtifact: "/tmp/ws/.codex-context.json",
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictOK}, nil)

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo:       "owner/repo",
		BaseBranch: "main",
		Brief:      "test brief",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.DesignPhaseResult
	s.NoError(env.GetWorkflowResult(&result))
	s.False(result.Skipped)
	s.Equal("test-session-00000001", result.SessionID)
	s.Len(result.Plan.Steps, 1)
	s.Equal("/tmp/ws", result.WorkDir)
}

func (s *designPhaseSuite) Test_CriticalBlock_Skips() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID: "test-session-00000001",
			Plan:      codexact.Plan{Theme: "theme", Steps: []codexact.Step{{Title: "step1"}}},
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictCriticalBlock, Feedback: "this is dangerous"}, nil)

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo: "owner/repo", BaseBranch: "main", Brief: "test",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.DesignPhaseResult
	s.NoError(env.GetWorkflowResult(&result))
	s.True(result.Skipped)
	s.Contains(result.SkipReason, "critical_block")
	s.Contains(result.SkipReason, "this is dangerous")
}

// Test_RefinesOnSuggest_UpdatesPlan verifies that a "suggest" review verdict
// triggers a refinement chat; when the response is valid JSON the full Plan
// (Theme and Steps) is replaced with the refined version.
func (s *designPhaseSuite) Test_RefinesOnSuggest_UpdatesPlan() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID: "test-session-00000001",
			Plan:      codexact.Plan{Theme: "original theme", Steps: []codexact.Step{{Title: "step1"}}},
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictSuggest, Feedback: "improve x"}, nil).Once()

	// Refinement returns a valid JSON plan with an updated theme and a new step list.
	env.OnActivity(acts.ChatActivity, mock.Anything, mock.Anything).
		Return(codexact.ChatResult{
			SessionID: "test-session-00000001",
			Response:  `{"theme":"refined theme","steps":[{"title":"step-a","description":"do a"},{"title":"step-b","description":"do b"}]}`,
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: "ok"}, nil).Once()

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo: "owner/repo", BaseBranch: "main", Brief: "test",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.DesignPhaseResult
	s.NoError(env.GetWorkflowResult(&result))
	s.False(result.Skipped)
	s.Equal("refined theme", result.Plan.Theme)
	// Steps must be updated from the refined plan, not kept from the original.
	s.Len(result.Plan.Steps, 2)
	s.Equal("step-a", result.Plan.Steps[0].Title)
}

// Test_RefinesOnSuggest_FallbackThemeOnly verifies that when the refinement chat
// returns partial JSON (theme only, no steps), only the Theme is updated.
func (s *designPhaseSuite) Test_RefinesOnSuggest_FallbackThemeOnly() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID: "test-session-00000001",
			Plan:      codexact.Plan{Theme: "original theme", Steps: []codexact.Step{{Title: "step1"}}},
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictSuggest, Feedback: "improve x"}, nil).Once()

	// JSON has a theme but no steps — falls back to theme-only update.
	env.OnActivity(acts.ChatActivity, mock.Anything, mock.Anything).
		Return(codexact.ChatResult{
			SessionID: "test-session-00000001",
			Response:  `{"theme":"better theme","steps":[]}`,
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: "ok"}, nil).Once()

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo: "owner/repo", BaseBranch: "main", Brief: "test",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.DesignPhaseResult
	s.NoError(env.GetWorkflowResult(&result))
	s.False(result.Skipped)
	s.Equal("better theme", result.Plan.Theme)
	// Original steps are preserved when the refined response has no steps.
	s.Len(result.Plan.Steps, 1)
	s.Equal("step1", result.Plan.Steps[0].Title)
}

func (s *designPhaseSuite) Test_PropagatesDesignActivityError() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{}, testErr("codex: exit status 1"))

	env.ExecuteWorkflow(workflow.DesignPhaseWorkflow, workflow.DesignPhaseInput{
		Repo: "owner/repo", BaseBranch: "main", Brief: "test",
	})

	s.True(env.IsWorkflowCompleted())
	s.Error(env.GetWorkflowError())
}

// testErr returns a non-nil error for use in mock returns.
func testErr(msg string) error {
	return fmt.Errorf("%s", msg)
}
