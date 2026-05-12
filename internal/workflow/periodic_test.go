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
	s.Require().Len(result.Steps, 2)
	s.Equal("step1", result.Steps[0].Title)
	s.Equal("completed", result.Steps[0].Status)
	s.Equal("step2", result.Steps[1].Title)
	s.Equal("completed", result.Steps[1].Status)
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

// Test_QueryProgress_DesignSkip verifies that after a design-skip, the progress
// query reflects the skipped state and PhaseDone.
func (s *periodicSuite) Test_QueryProgress_DesignSkip() {
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

	encoded, err := env.QueryWorkflow(workflow.QueryProgress)
	s.NoError(err)
	var progress workflow.RefactorProgress
	s.NoError(encoded.Get(&progress))

	s.Equal(workflow.PhaseDone, progress.Phase)
	s.True(progress.Skipped)
	s.Equal("planner returned no steps", progress.SkipReason)
	s.Equal(0, progress.StepsDone)
}

// Test_QueryProgress_HappyPath verifies that after a full cycle, the progress
// query reflects the correct step count, PR info, and PhaseDone.
func (s *periodicSuite) Test_QueryProgress_HappyPath() {
	env := s.NewTestWorkflowEnvironment()

	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID: "test-session-00000001",
			Plan: codexact.Plan{
				Theme: "refactor theme",
				Steps: []codexact.Step{{Title: "step1"}, {Title: "step2"}},
			},
			WorkDir: "/tmp/ws",
			Branch:  "codex-session/test",
		}, nil)

	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "completed", CommitSHA: "sha1"}, nil)

	env.OnWorkflow(workflow.RobustPRMergeWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RobustPRMergeResult{
			PRNumber: 42,
			PRURL:    "https://github.com/owner/repo/pull/42",
			Outcome:  "merged",
		}, nil)

	env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
		RepoFullName: "owner/repo",
		BaseBranch:   "main",
		Brief:        "test",
		PRTitle:      "chore: test",
		PRBody:       "body",
		AutoMerge:    true,
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())

	encoded, err := env.QueryWorkflow(workflow.QueryProgress)
	s.NoError(err)
	var progress workflow.RefactorProgress
	s.NoError(encoded.Get(&progress))

	s.Equal(workflow.PhaseDone, progress.Phase)
	s.False(progress.Skipped)
	s.Equal(2, progress.StepsDone)
	s.Equal(2, progress.TotalSteps)
	s.Equal(42, progress.PRNumber)
	s.Equal("https://github.com/owner/repo/pull/42", progress.PRURL)
	s.Require().Len(progress.Steps, 2)
	s.Equal("step1", progress.Steps[0].Title)
	s.Equal("completed", progress.Steps[0].Status)
	s.Equal("sha1", progress.Steps[0].CommitSHA)
	s.Equal("step2", progress.Steps[1].Title)
	s.Equal("completed", progress.Steps[1].Status)
}

// Test_QueryProgress_AllStepsFail verifies that when all steps fail, progress
// reflects the skipped state with the correct reason.
func (s *periodicSuite) Test_QueryProgress_AllStepsFail() {
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

	encoded, err := env.QueryWorkflow(workflow.QueryProgress)
	s.NoError(err)
	var progress workflow.RefactorProgress
	s.NoError(encoded.Get(&progress))

	s.Equal(workflow.PhaseDone, progress.Phase)
	s.True(progress.Skipped)
	s.Equal("no steps completed successfully", progress.SkipReason)
	s.Equal(0, progress.StepsDone)
	s.Require().Len(progress.Steps, 1)
	s.Equal("step1", progress.Steps[0].Title)
	s.Equal("error", progress.Steps[0].Status)
}

// Test_PartialCompletion_CircuitBrokenMidLoop verifies that when the first step
// completes and the second is circuit-broken (no execution error), the result and
// progress query both contain two StepRecords — one "completed" and one
// "circuit-broken" — while StepsDone reflects only the successful step.
func (s *periodicSuite) Test_PartialCompletion_CircuitBrokenMidLoop() {
	env := s.NewTestWorkflowEnvironment()

	env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
		Return(workflow.DesignPhaseResult{
			SessionID: "test-session-00000001",
			Plan: codexact.Plan{
				Theme: "refactor theme",
				Steps: []codexact.Step{
					{Title: "step1", Description: "do step 1"},
					{Title: "step2", Description: "do step 2"},
				},
			},
			WorkDir: "/tmp/ws",
			Branch:  "codex-session/test",
		}, nil)

	// First step completes successfully.
	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "completed", CommitSHA: "sha1"}, nil).Once()

	// Second step is circuit-broken (no error returned by the child workflow itself).
	env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RefactorStepResult{Kind: "circuit-broken"}, nil).Once()

	env.OnWorkflow(workflow.RobustPRMergeWorkflow, mock.Anything, mock.Anything).
		Return(workflow.RobustPRMergeResult{
			PRNumber: 7,
			PRURL:    "https://github.com/owner/repo/pull/7",
			Outcome:  "auto-merge-disabled",
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

	s.False(result.Skipped)
	s.Equal(1, result.StepsDone)
	s.Equal(7, result.PRNumber)

	s.Require().Len(result.Steps, 2)
	s.Equal("step1", result.Steps[0].Title)
	s.Equal("completed", result.Steps[0].Status)
	s.Equal("sha1", result.Steps[0].CommitSHA)
	s.Equal("step2", result.Steps[1].Title)
	s.Equal("circuit-broken", result.Steps[1].Status)
	s.Empty(result.Steps[1].CommitSHA)

	// Verify the live progress query also reflects both records.
	encoded, err := env.QueryWorkflow(workflow.QueryProgress)
	s.NoError(err)
	var progress workflow.RefactorProgress
	s.NoError(encoded.Get(&progress))
	s.Equal(workflow.PhaseDone, progress.Phase)
	s.Equal(1, progress.StepsDone)
	s.Require().Len(progress.Steps, 2)
	s.Equal("circuit-broken", progress.Steps[1].Status)
}
