package errors

import "go.temporal.io/sdk/temporal"

const (
	CodeMissingCredentials = "MISSING_CREDENTIALS"
	CodeInvalidGitRef      = "INVALID_GIT_REF"
	CodeWorkdirMissing     = "WORKDIR_MISSING"
	CodeCITimeout          = "CI_TIMEOUT"
	CodeMaxIterations      = "MAX_ITERATIONS"
	CodeNoFixDiff          = "NO_FIX_DIFF"
	CodeAdvisorAbort       = "ADVISOR_ABORT"
	CodePlannerInvalid     = "PLANNER_INVALID"
	CodeInvalidGitHubOut   = "INVALID_GITHUB_OUTPUT"
)

func NewNonRetryable(code, message string) error {
	return temporal.NewNonRetryableApplicationError(message, code, nil)
}

func NewMissingCredentials(detail string) error {
	return NewNonRetryable(CodeMissingCredentials, "missing credentials: "+detail)
}

func NewCITimeout() error {
	return NewNonRetryable(CodeCITimeout, "CI did not complete within the allotted time")
}

func NewMaxIterations() error {
	return NewNonRetryable(CodeMaxIterations, "maximum self-heal iterations exceeded")
}

func NewNoFixDiff() error {
	return NewNonRetryable(CodeNoFixDiff, "codex produced no diff when fixing CI failure")
}

func AdvisorAbort(rationale string) error {
	return NewNonRetryable(CodeAdvisorAbort, "advisor aborted: "+rationale)
}

func NewWorkdirMissing(path string) error {
	return NewNonRetryable(CodeWorkdirMissing, "workspace directory missing: "+path)
}

func NewPlannerInvalid(detail string) error {
	return NewNonRetryable(CodePlannerInvalid, "invalid plan: "+detail)
}
