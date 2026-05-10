package workflow_test

import (
	"testing"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
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

// setupCleanup registers a mock for CleanupWorkspaceActivity so tests that
// exercise code paths with a non-empty WorkDir don't fail on the cleanup call.
func (s *periodicSuite) setupCleanup(env *testsuite.TestWorkflowEnvironment) {
	var gitActs *gitact.Activities
	env.OnActivity(gitActs.CleanupWorkspaceActivity, mock.Anything, mock.Anything).Return(nil)
}

func (s *periodicSuite) Test_SkipsWhenDesignPhaseSkips() {
	env := s.NewTestWorkflowEnvironment()

	// No WorkDir → cleanupWorkspace is a no-op; no activity mock needed.
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
	s.setupCleanup(env)

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
	s.setupCleanup(env)

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
	s.setupCleanup(env)

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

	// No WorkDir → cleanupWorkspace is a no-op; no activity mock needed.
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
	s.setupCleanup(env)

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
}

// Test_QueryProgress_AllStepsFail verifies that when all steps fail, progress
// reflects the skipped state with the correct reason.
func (s *periodicSuite) Test_QueryProgress_AllStepsFail() {
	env := s.NewTestWorkflowEnvironment()
	s.setupCleanup(env)

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
}

// Test_Cleanup_CalledOnAllExitPaths verifies that CleanupWorkspaceActivity is
// invoked exactly once on each non-trivial exit path (steps-fail and happy path).
// This prevents disk accumulation across runs.
func (s *periodicSuite) Test_Cleanup_CalledOnAllExitPaths() {
	for _, tc := range []struct {
		name       string
		steps      bool // true = steps complete, false = all fail
		hasPR      bool
	}{
		{"all-steps-fail", false, false},
		{"happy-path-with-PR", true, true},
	} {
		s.Run(tc.name, func() {
			env := s.NewTestWorkflowEnvironment()
			var gitActs *gitact.Activities
			cleanupCalled := 0
			env.OnActivity(gitActs.CleanupWorkspaceActivity, mock.Anything, "/tmp/ws").
				Return(nil).
				Run(func(args mock.Arguments) {
					cleanupCalled++
				})

			env.OnWorkflow(workflow.DesignPhaseWorkflow, mock.Anything, mock.Anything).
				Return(workflow.DesignPhaseResult{
					SessionID: "test-session-00000001",
					Plan: codexact.Plan{
						Theme: "t",
						Steps: []codexact.Step{{Title: "step1"}},
					},
					WorkDir: "/tmp/ws",
					Branch:  "codex-session/test",
				}, nil)

			if tc.steps {
				env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
					Return(workflow.RefactorStepResult{Kind: "completed", CommitSHA: "sha"}, nil)
				env.OnWorkflow(workflow.RobustPRMergeWorkflow, mock.Anything, mock.Anything).
					Return(workflow.RobustPRMergeResult{PRNumber: 1, Outcome: "auto-merge-disabled"}, nil)
			} else {
				env.OnWorkflow(workflow.RefactorStepWorkflow, mock.Anything, mock.Anything).
					Return(workflow.RefactorStepResult{Kind: "circuit-broken"}, testErr("no changes"))
			}

			env.ExecuteWorkflow(workflow.PeriodicRefactorWorkflow, workflow.PeriodicRefactorInput{
				RepoFullName: "owner/repo",
				BaseBranch:   "main",
				Brief:        "test",
				PRTitle:      "chore: test",
				PRBody:       "body",
			})

			s.True(env.IsWorkflowCompleted())
			s.NoError(env.GetWorkflowError())
			s.Equal(1, cleanupCalled, "CleanupWorkspaceActivity should be called exactly once")
		})
	}
}
