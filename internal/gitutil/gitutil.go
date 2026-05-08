package gitutil

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
)

// Run executes a git command in dir and returns an error if it fails.
func Run(ctx context.Context, dir string, args ...string) error {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git %v: %w\n%s", args, err, errBuf.String())
	}
	return nil
}

// Output executes a git command in dir and returns its stdout.
func Output(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %v: %w\n%s", args, err, errBuf.String())
	}
	return string(out), nil
}
