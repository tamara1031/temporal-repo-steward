package git

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"go.temporal.io/sdk/activity"
)

// Activities holds git operation implementations.
type Activities struct {
	BotName  string
	BotEmail string
	Token    string
}

// CloneInput is the input to CloneRepoActivity.
type CloneInput struct {
	RepoFullName string
	BaseBranch   string
	WorkDir      string
	Branch       string
}

// CloneRepoActivity clones the repo and creates a working branch.
func (a *Activities) CloneRepoActivity(ctx context.Context, in CloneInput) error {
	if err := os.MkdirAll(in.WorkDir, 0o755); err != nil {
		return err
	}

	cloneURL := fmt.Sprintf("https://x-access-token:%s@github.com/%s.git", a.Token, in.RepoFullName)
	if err := run(ctx, in.WorkDir, "git", "clone", "--branch="+in.BaseBranch, cloneURL, "."); err != nil {
		return fmt.Errorf("clone: %w", err)
	}
	activity.RecordHeartbeat(ctx, "cloned")

	if err := run(ctx, in.WorkDir, "git", "config", "user.name", a.BotName); err != nil {
		return err
	}
	if err := run(ctx, in.WorkDir, "git", "config", "user.email", a.BotEmail); err != nil {
		return err
	}
	return run(ctx, in.WorkDir, "git", "checkout", "-b", in.Branch)
}

// CommitAllInput is the input to CommitAllActivity.
type CommitAllInput struct {
	WorkDir string
	Message string
}

// CommitAllActivity stages all changes and creates a commit.
// Returns the commit SHA, or an error if there is nothing to commit.
func (a *Activities) CommitAllActivity(ctx context.Context, in CommitAllInput) (string, error) {
	if err := run(ctx, in.WorkDir, "git", "add", "-A"); err != nil {
		return "", err
	}

	out, err := output(ctx, in.WorkDir, "git", "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(out) == "" {
		return "", fmt.Errorf("no changes to commit")
	}

	if err := run(ctx, in.WorkDir, "git", "commit", "-m", in.Message); err != nil {
		return "", fmt.Errorf("commit: %w", err)
	}

	sha, err := output(ctx, in.WorkDir, "git", "rev-parse", "HEAD")
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
	return run(ctx, in.WorkDir, "git", args...)
}

// StatusPorcelainActivity returns the porcelain status of the working tree.
func (a *Activities) StatusPorcelainActivity(ctx context.Context, workDir string) (string, error) {
	return output(ctx, workDir, "git", "status", "--porcelain")
}

// DiffStatActivity returns a short diff stat of staged changes vs HEAD.
func (a *Activities) DiffStatActivity(ctx context.Context, workDir string) (string, error) {
	return output(ctx, workDir, "git", "diff", "--stat", "HEAD")
}

// RestoreActivity discards all uncommitted changes.
func (a *Activities) RestoreActivity(ctx context.Context, workDir string) error {
	if err := run(ctx, workDir, "git", "restore", "."); err != nil {
		return err
	}
	return run(ctx, workDir, "git", "clean", "-fd")
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
	err := run(ctx, in.WorkDir, "git", "merge", "--no-commit", "--no-ff", "origin/"+in.BaseBranch)
	if err != nil {
		_ = run(ctx, in.WorkDir, "git", "merge", "--abort")
		return true, nil
	}
	_ = run(ctx, in.WorkDir, "git", "merge", "--abort")
	return false, nil
}

// WorkspacePath returns a unique workspace path for a given repo and branch.
func WorkspacePath(root, repoFullName, branch string) string {
	safe := strings.ReplaceAll(repoFullName, "/", "_")
	return filepath.Join(root, safe+"_"+branch)
}

// ── helpers ───────────────────────────────────────────────────────────────────

func run(ctx context.Context, dir string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %v: %w\n%s", name, args, err, errBuf.String())
	}
	return nil
}

func output(ctx context.Context, dir string, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("%s %v: %w", name, args, err)
	}
	return string(out), nil
}
