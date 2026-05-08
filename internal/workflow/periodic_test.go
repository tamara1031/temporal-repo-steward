package workflow_test

import (
	"testing"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"
)

type periodicSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
}

func TestPeriodicSuite(t *testing.T) {
	suite.Run(t, new(periodicSuite))
}

func (s *periodicSuite) Test_SkipsWhenDesignPhaseSkips() {
	env := s.NewTestWorkflowEnvironment()

	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID:  "test-session-00000001",
			Skipped:    true,
			SkipReason: "planner returned no steps",
		}, nil)

	env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
		RepoFullName: "owner/repo",
		BaseBranch:   "main",
		Brief:        "test",
		PRTitle:      "chore: test",
		PRBody:       "body",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.PeriodicRefactorResult
	s.NoError(env.GetWorkflowResult(&result))
	s.True(result.Skipped)
	s.Equal("planner returned no steps", result.SkipReason)
}

func (s *periodicSuite) Test_SkipsWhenAllStepsFail() {
	env := s.NewTestWorkflowEnvironment()

	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID: "test-session-00000001",
			Plan: codexact.Plan{
				Theme: "refactor theme",
				Steps: []codexact.Step{{Title: "step1"}},
			},
			WorkDir: "/tmp/ws",
			Branch:  "codex-session/test",
		}, nil)

	// All step child workflows fail.
	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "circuit-broken"}, testErr("implement produced no changes"))

	env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
		RepoFullName: "owner/repo",
		BaseBranch:   "main",
		Brief:        "test",
		PRTitle:      "chore: test",
		PRBody:       "body",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.PeriodicRefactorResult
	s.NoError(env.GetWorkflowResult(&result))
	s.True(result.Skipped)
	s.Equal("no steps completed successfully", result.SkipReason)
}

func (s *periodicSuite) Test_HappyPath_AutoMergeDisabled() {
	env := s.NewTestWorkflowEnvironment()

	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID: "test-session-00000001",
			Plan: codexact.Plan{
				Theme: "refactor theme",
				Steps: []codexact.Step{
					{Title: "step1"},
					{Title: "step2"},
				},
			},
			WorkDir: "/tmp/ws",
			Branch:  "codex-session/test",
		}, nil)

	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "completed", CommitSHA: "sha1"}, nil)

	env.OnWorkflow(workflow.RobustPRMergeWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RobustPRMergeResult{
			PRNumber: 99,
			PRURL:    "https://github.com/owner/repo/pull/99",
			Outcome:  "auto-merge-disabled",
		}, nil)

	env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
		RepoFullName: "owner/repo",
		BaseBranch:   "main",
		Brief:        "test",
		PRTitle:      "chore: test",
		PRBody:       "body",
		AutoMerge:    false,
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.PeriodicRefactorResult
	s.NoError(env.GetWorkflowResult(&result))
	s.False(result.Skipped)
	s.Equal(2, result.StepsDone) // maxStepsPerRun=2, both steps ran
	s.Equal(99, result.PRNumber)
	s.Equal("auto-merge-disabled", result.PROutcome)
}

// Test_StepsCapAtMaxStepsPerRun verifies that even when the plan has more steps
// than maxStepsPerRun, only maxStepsPerRun child workflows are dispatched.
func (s *periodicSuite) Test_StepsCapAtMaxStepsPerRun() {
	env := s.NewTestWorkflowEnvironment()

	// Plan has 4 steps but maxStepsPerRun=2.
	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID: "test-session-00000001",
			Plan: codexact.Plan{
				Theme: "big refactor",
				Steps: []codexact.Step{
					{Title: "step1"}, {Title: "step2"}, {Title: "step3"}, {Title: "step4"},
				},
			},
			WorkDir: "/tmp/ws",
			Branch:  "codex-session/test",
		}, nil)

	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "completed", CommitSHA: "sha"}, nil)

	env.OnWorkflow(workflow.RobustPRMergeWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RobustPRMergeResult{PRNumber: 1, Outcome: "auto-merge-disabled"}, nil)

	env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
		RepoFullName: "owner/repo",
		BaseBranch:   "main",
		Brief:        "test",
		PRTitle:      "chore: test",
		PRBody:       "body",
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.PeriodicRefactorResult
	s.NoError(env.GetWorkflowResult(&result))
	// maxStepsPerRun=2: regardless of the 4-step plan, only 2 execute.
	s.Equal(2, result.StepsDone)
}
