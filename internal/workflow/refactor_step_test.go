package workflow_test

import (
	"testing"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
	"go.temporal.io/sdk/testsuite"
)

type refactorStepSuite struct {
	suite.Suite
	testsuite.WorkflowTestSuite
}

func TestRefactorStepSuite(t *testing.T) {
	suite.Run(t, new(refactorStepSuite))
}

func (s *refactorStepSuite) Test_Completed() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.ImplementActivity, mock.Anything, mock.Anything).
		Return(codexact.ImplementResult{
			SessionID:  "test-session-00000001",
			HasChanges: true,
			CommitSHA:  "abc123",
		}, nil)

	// Both review concerns ("correctness", "quality") return ok.
	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictOK}, nil)

	env.ExecuteWorkflow(workflow.RefactorStepWorkflow, workflow.RefactorStepInput{
		SessionID: "test-session-00000001",
		Step:      codexact.Step{Title: "step1", Description: "do something"},
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RefactorStepResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.StepCompleted, result.Kind)
	s.Equal("abc123", result.CommitSHA)
}

func (s *refactorStepSuite) Test_CircuitBroken_NoChanges() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.ImplementActivity, mock.Anything, mock.Anything).
		Return(codexact.ImplementResult{HasChanges: false}, nil)

	env.ExecuteWorkflow(workflow.RefactorStepWorkflow, workflow.RefactorStepInput{
		SessionID: "test-session-00000001",
		Step:      codexact.Step{Title: "step1"},
	})

	s.True(env.IsWorkflowCompleted())
	// Workflow returns an error when no changes are produced.
	s.Error(env.GetWorkflowError())
}

// Test_BudgetHalted_AdvisorRetries covers the path where every review iteration
// returns critical_block but the advisor says "retry" — budget exhausts and
// the workflow returns "budget-halted" without error.
func (s *refactorStepSuite) Test_BudgetHalted_AdvisorRetries() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	// maxStepIter = 2: implement is called once per iteration.
	env.OnActivity(acts.ImplementActivity, mock.Anything, mock.Anything).
		Return(codexact.ImplementResult{HasChanges: true, CommitSHA: "sha1"}, nil)

	// Every review returns critical_block, causing a block each iteration.
	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictCriticalBlock, Feedback: "not safe"}, nil)

	// On the last iteration the advisor is consulted; it returns "retry",
	// so the workflow does not abort — it simply exhausts its budget.
	env.OnActivity(acts.ConsultAdvisorActivity, mock.Anything, mock.Anything).
		Return(codexact.AdvisorVerdict{Verdict: codexact.AdvisorVerdictRetry, Rationale: "maybe next time"}, nil)

	env.ExecuteWorkflow(workflow.RefactorStepWorkflow, workflow.RefactorStepInput{
		SessionID: "test-session-00000001",
		Step:      codexact.Step{Title: "step1"},
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RefactorStepResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.StepBudgetHalted, result.Kind)
}

// Test_CircuitBroken_AdvisorAborts verifies that when the advisor returns "abort"
// on the final iteration, the workflow terminates with a non-retryable error.
func (s *refactorStepSuite) Test_CircuitBroken_AdvisorAborts() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.ImplementActivity, mock.Anything, mock.Anything).
		Return(codexact.ImplementResult{HasChanges: true, CommitSHA: "sha1"}, nil)

	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictCriticalBlock, Feedback: "dangerous"}, nil)

	env.OnActivity(acts.ConsultAdvisorActivity, mock.Anything, mock.Anything).
		Return(codexact.AdvisorVerdict{Verdict: codexact.AdvisorVerdictAbort, Rationale: "too risky"}, nil)

	env.ExecuteWorkflow(workflow.RefactorStepWorkflow, workflow.RefactorStepInput{
		SessionID: "test-session-00000001",
		Step:      codexact.Step{Title: "step1"},
	})

	s.True(env.IsWorkflowCompleted())
	s.Error(env.GetWorkflowError())
}

// Test_Retries_WhenFirstIterationBlocked verifies that a "correctness" block
// on the first iteration triggers a retry and the second iteration succeeds.
func (s *refactorStepSuite) Test_Retries_WhenFirstIterationBlocked() {
	env := s.NewTestWorkflowEnvironment()
	var acts *codexact.Activities

	env.OnActivity(acts.ImplementActivity, mock.Anything, mock.Anything).
		Return(codexact.ImplementResult{HasChanges: true, CommitSHA: "sha2"}, nil)

	// Iter 0: critical_block on correctness → blocked, retry.
	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictCriticalBlock, Feedback: "fix it"}, nil).Once()

	// Iter 1: both concerns pass → completed.
	env.OnActivity(acts.ReviewActivity, mock.Anything, mock.Anything).
		Return(codexact.ReviewResult{Verdict: codexact.VerdictOK}, nil)

	env.ExecuteWorkflow(workflow.RefactorStepWorkflow, workflow.RefactorStepInput{
		SessionID: "test-session-00000001",
		Step:      codexact.Step{Title: "step1"},
	})

	s.True(env.IsWorkflowCompleted())
	s.NoError(env.GetWorkflowError())
	var result workflow.RefactorStepResult
	s.NoError(env.GetWorkflowResult(&result))
	s.Equal(workflow.StepCompleted, result.Kind)
	s.Equal("sha2", result.CommitSHA)
}
