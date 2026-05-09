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
		Return(codexact.ReviewResult{Verdict: "ok"}, nil)

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
		Return(codexact.ReviewResult{Verdict: "critical_block", Feedback: "this is dangerous"}, nil)

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

func (s *designPhaseSuite) Test_RefinesOnSuggest_ThenOK() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.DesignActivity, mock.Anything, mock.Anything).
		Return(codexact.DesignResult{
			SessionID: "test-session-00000001",
			Plan:      codexact.Plan{Theme: "original theme", Steps: []codexact.Step{{Title: "step1"}}},
		}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: "suggest", Feedback: "improve x"}, nil).Once()

	env.OnActivity(acts.ChatActivity, mock.Anything, mock.Anything).
		Return(codexact.ChatResult{SessionID: "test-session-00000001", Response: `{"theme":"refined theme","steps":[{"title":"step1","description":"refined desc"}]}`}, nil)

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
