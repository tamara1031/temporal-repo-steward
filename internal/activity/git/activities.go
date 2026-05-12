package git

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/tamara1031/temporal-repo-steward/internal/gitutil"
	"go.temporal.io/sdk/activity"
)

// Activities holds git operation implementations.
type Activities struct {
	BotName  string
	BotEmail string
	Token    string
}

// CommitAllInput is the input to CommitAllActivity.
type CommitAllInput struct {
	WorkDir string
	Message string
}

// CommitAllActivity stages all changes and creates a commit.
// Returns the commit SHA, or an error if there is nothing to commit.
func (a *Activities) CommitAllActivity(ctx context.Context, in CommitAllInput) (string, error) {
	if err := gitutil.Run(ctx, in.WorkDir, "git", "add", "-A"); err != nil {
		return "", err
	}

	out, err := gitutil.Output(ctx, in.WorkDir, "git", "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("no changes to commit")
	}

	if err := gitutil.Run(ctx, in.WorkDir, "git", "commit", "-m", in.Message); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}

	sha, err := gitutil.Output(ctx, in.WorkDir, "git", "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(sha), nil
}

// PushInput is the input to PushBranchActivity.
type PushInput struct {
	WorkDir string
	Branch  string
	Force   bool
}

// PushBranchActivity pushes the branch to origin.
func (a *Activities) PushBranchActivity(ctx context.Context, in PushInput) error {
	activity.RecordHeartbeat(ctx, "pushing")
	args := []string{"push", "-u", "origin", in.Branch}
	if in.Force {
		args = []string{"push", "--force-with-lease", "origin", in.Branch}
	}
	return gitutil.Run(ctx, in.WorkDir, "git", args...)
}

// StatusPorcelainActivity returns the porcelain status of the working tree.
func (a *Activities) StatusPorcelainActivity(ctx context.Context, workDir string) (string, error) {
	return gitutil.Output(ctx, workDir, "git", "status", "--porcelain")
}

// DiffStatActivity returns a short diff stat of staged changes vs HEAD.
func (a *Activities) DiffStatActivity(ctx context.Context, workDir string) (string, error) {
	return gitutil.Output(ctx, workDir, "git", "diff", "--stat", "HEAD")
}

// RestoreActivity discards all uncommitted changes.
func (a *Activities) RestoreActivity(ctx context.Context, workDir string) error {
	if err := gitutil.Run(ctx, workDir, "git", "restore", "."); err != nil {
		return err
	}
	return gitutil.Run(ctx, workDir, "git", "clean", "-fd")
}

// CleanupWorkspaceActivity removes the workspace directory.
func (a *Activities) CleanupWorkspaceActivity(ctx context.Context, workDir string) error {
	return os.RemoveAll(workDir)
}

// CheckConflictInput is the input to CheckConflictActivity.
type CheckConflictInput struct {
	WorkDir    string
	BaseBranch string
}

// CheckConflictActivity returns true if merging base into HEAD would cause a conflict.
func (a *Activities) CheckConflictActivity(ctx context.Context, in CheckConflictInput) (bool, error) {
	err := gitutil.Run(ctx, in.WorkDir, "git", "merge", "--no-commit", "--no-ff", "origin/"+in.BaseBranch)
	if err != nil {
		_ = gitutil.Run(ctx, in.WorkDir, "git", "merge", "--abort")
		return true, nil
	}
	_ = gitutil.Run(ctx, in.WorkDir, "git", "merge", "--abort")
	return false, nil
}

