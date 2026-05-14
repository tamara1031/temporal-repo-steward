package errors_test

import (
	"errors"
	"strings"
	"testing"

	rserrors "github.com/tamara1031/temporal-repo-steward/internal/errors"
	"go.temporal.io/sdk/temporal"
)

func TestErrorConstructors(t *testing.T) {
	cases := []struct {
		name    string
		err     error
		code    string
		msgFrag string
	}{
		{
			name:    "missing credentials",
			err:     rserrors.NewMissingCredentials("GITHUB_TOKEN"),
			code:    rserrors.CodeMissingCredentials,
			msgFrag: "GITHUB_TOKEN",
		},
		{
			name: "ci timeout",
			err:  rserrors.NewCITimeout(),
			code: rserrors.CodeCITimeout,
		},
		{
			name: "max iterations",
			err:  rserrors.NewMaxIterations(),
			code: rserrors.CodeMaxIterations,
		},
		{
			name: "no fix diff",
			err:  rserrors.NewNoFixDiff(),
			code: rserrors.CodeNoFixDiff,
		},
		{
			name:    "advisor abort",
			err:     rserrors.AdvisorAbort("plan was unsound"),
			code:    rserrors.CodeAdvisorAbort,
			msgFrag: "plan was unsound",
		},
		{
			name:    "workdir missing",
			err:     rserrors.NewWorkdirMissing("/tmp/missing"),
			code:    rserrors.CodeWorkdirMissing,
			msgFrag: "/tmp/missing",
		},
		{
			name:    "invalid github out",
			err:     rserrors.NewInvalidGitHubOut(`{"bad":"json"`),
			code:    rserrors.CodeInvalidGitHubOut,
			msgFrag: `{"bad":"json"`,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var appErr *temporal.ApplicationError
			if !errors.As(c.err, &appErr) {
				t.Fatalf("expected *temporal.ApplicationError, got %T", c.err)
			}
			if appErr.Type() != c.code {
				t.Errorf("code: got %q, want %q", appErr.Type(), c.code)
			}
			if !appErr.NonRetryable() {
				t.Error("expected NonRetryable() == true")
			}
			if c.msgFrag != "" && !strings.Contains(appErr.Message(), c.msgFrag) {
				t.Errorf("message %q does not contain %q", appErr.Message(), c.msgFrag)
			}
		})
	}
}
