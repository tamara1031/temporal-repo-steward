package workflow_test

import (
	"testing"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
	ghact "github.com/tamara1031/temporal-repo-steward/internal/activity/github"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"
)

type prLifecycleSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
}

func TestPRLifecycleSuite(t *testing.T) {
	suite.Run(t, new(prLifecycleSuite))
}

func mergeInput(autoMerge bool) workflow.RobustPRMergeInput {
	return workflow.RobustPRMergeInput{
		RepoFullName: "owner/repo",
		WorkDir:      "/tmp/ws",
		Branch:       "codex-session/test",
		BaseBranch:   "main",
		PRTitle:      "chore: automated refactor",
		PRBody:       "body",
		SessionID:    "test-session-00000001",
		AutoMerge:    autoMerge,
	}
}

func (s *prLifecycleSuite) setupPushAndCreate(env *testsuite.TestWorkflowEnvironment) {
	var gitActs *gitact.Activities
	var ghActs *ghact.Activities
	env.OnActivity(gitActs.PushBranchActivity, mock.Anything, mock.Anything).Return(nil)
	env.OnActivity(ghActs.CreatePRActivity, mock.Anything, mock.Anything).
		Return(ghact.CreatePRResult{Number: 42, URL: "https://github.com/owner/repo/pull/42"}, nil)
}

func (s *prLifecycleSuite) Test_AutoMergeDisabled_WhenCIPasses() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	s.setupPushAndCreate(env)

	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeSuccess}, nil)

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RobustPRMergeResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(42, result.PRNumber)
	s.Equal(workflow.PROutcomeAutoMergeDisabled, result.Outcome)
	s.False(result.Merged)
}

func (s *prLifecycleSuite) Test_ExternallyMerged() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	s.setupPushAndCreate(env)

	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeExternallyMerged}, nil)

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RobustPRMergeResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.PROutcomeExternallyMerged, result.Outcome)
	s.True(result.Merged)
}

func (s *prLifecycleSuite) Test_ExternallyClosed() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	s.setupPushAndCreate(env)

	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeExternallyClosed}, nil)

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RobustPRMergeResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.PROutcomeExternallyClosed, result.Outcome)
	s.False(result.Merged)
}

func (s *prLifecycleSuite) Test_AutoMerge_CIPassesThenMerges() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	s.setupPushAndCreate(env)

	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeSuccess}, nil)

	env.OnActivity(ghActs.MergePRActivity, mock.Anything, mock.Anything).Return(nil)

	env.OnActivity(ghActs.ObservePRStateActivity, mock.Anything, mock.Anything).
		Return(ghact.CIOutcomeSuccess, nil)

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(true))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RobustPRMergeResult
	s.NoError(env.GetWorkflowResult(&result))
	s.True(result.Merged)
	s.Equal(42, result.PRNumber)
}

// Test_SelfHeal_OneCIFailureThenSuccess verifies the self-heal loop:
// CI fails once → codex fixes it → push → CI passes → auto-merge-disabled.
func (s *prLifecycleSuite) Test_SelfHeal_OneCIFailureThenSuccess() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	var gitActs *gitact.Activities
	var codexActs *codexact.Activities
	s.setupPushAndCreate(env)

	// First CI poll: failure.
	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{
			Outcome:    ghact.CIOutcomeFailure,
			FailedRuns: []string{"https://github.com/owner/repo/actions/runs/1"},
		}, nil).Once()

	env.OnActivity(ghActs.FetchFailedRunLogsActivity, mock.Anything, mock.Anything).
		Return("error: undefined: Foo\n", nil)

	env.OnActivity(codexActs.ChatActivity, mock.Anything, mock.Anything).
		Return(codexact.ChatResult{SessionID: "test-session-00000001", Response: "fixed"}, nil)

	env.OnActivity(gitActs.CommitAllActivity, mock.Anything, mock.Anything).
		Return("fixsha", nil)

	// Force-push after fix.
	env.OnActivity(gitActs.PushBranchActivity, mock.Anything, mock.Anything).Return(nil)

	// Second CI poll: success.
	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeSuccess}, nil).Once()

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RobustPRMergeResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.PROutcomeAutoMergeDisabled, result.Outcome)
	s.Equal(42, result.PRNumber)
}

// Test_QueryCIProgress_PRCreated verifies that after a clean CI pass, the
// ci_progress query exposes the PR number, URL, and last CI outcome.
func (s *prLifecycleSuite) Test_QueryCIProgress_PRCreated() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	s.setupPushAndCreate(env)

	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeSuccess}, nil)

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())

	encoded, err := env.QueryWorkflow(workflow.QueryCIProgress)
	s.NoError(err)
	var progress workflow.CIProgress
	s.NoError(encoded.Get(&progress))

	s.Equal(42, progress.PRNumber)
	s.Equal("https://github.com/owner/repo/pull/42", progress.PRURL)
	s.Equal(ghact.CIOutcomeSuccess, progress.LastOutcome)
	s.Equal(maxFixIterations, progress.MaxIterations)
}

// Test_QueryCIProgress_SelfHealIteration verifies that after one CI failure and
// a successful fix, the ci_progress query reflects the correct iteration count
// and the final CI outcome.
func (s *prLifecycleSuite) Test_QueryCIProgress_SelfHealIteration() {
	env := s.NewTestWorkflowEnvironment()
	var ghActs *ghact.Activities
	var gitActs *gitact.Activities
	var codexActs *codexact.Activities
	s.setupPushAndCreate(env)

	// First CI: failure.
	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeFailure}, nil).Once()

	env.OnActivity(ghActs.FetchFailedRunLogsActivity, mock.Anything, mock.Anything).
		Return("error: undefined: Foo\n", nil)

	env.OnActivity(codexActs.ChatActivity, mock.Anything, mock.Anything).
		Return(codexact.ChatResult{SessionID: "test-session-00000001", Response: "fixed"}, nil)

	env.OnActivity(gitActs.CommitAllActivity, mock.Anything, mock.Anything).
		Return("fixsha", nil)

	env.OnActivity(gitActs.PushBranchActivity, mock.Anything, mock.Anything).Return(nil)

	// Second CI: success.
	env.OnActivity(ghActs.WaitForCIActivity, mock.Anything, mock.Anything).
		Return(ghact.WaitForCIResult{Outcome: ghact.CIOutcomeSuccess}, nil).Once()

	env.ExecuteWorkflow(workflow.RobustPRMergeWorkflow, mergeInput(false))

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())

	encoded, err := env.QueryWorkflow(workflow.QueryCIProgress)
	s.NoError(err)
	var progress workflow.CIProgress
	s.NoError(encoded.Get(&progress))

	s.Equal(42, progress.PRNumber)
	// Iteration 1 (0-indexed) is where success was observed.
	s.Equal(1, progress.Iteration)
	s.Equal(ghact.CIOutcomeSuccess, progress.LastOutcome)
}

// maxFixIterations is re-exported via the test package for assertion purposes.
// Keep in sync with the unexported constant in pr_lifecycle.go.
const maxFixIterations = 8
