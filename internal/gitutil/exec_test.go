package gitutil_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tamara1031/temporal-repo-steward/internal/gitutil"
)

func TestRun_success(t *testing.T) {
	ctx := context.Background()
	if err := gitutil.Run(ctx, os.TempDir(), "true"); err != nil {
		t.Fatalf("expected no error, got: %v", err)
	}
}

func TestRun_failure_includesStderr(t *testing.T) {
	ctx := context.Background()
	err := gitutil.Run(ctx, os.TempDir(), "ls", "/path/that/does/not/exist/ever")
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
}

func TestOutput_success(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	out, err := gitutil.Output(ctx, dir, "echo", "hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "hello") {
		t.Fatalf("expected 'hello' in output, got %q", out)
	}
}

func TestOutput_failure_includesStderr(t *testing.T) {
	ctx := context.Background()
	_, err := gitutil.Output(ctx, os.TempDir(), "ls", "/path/that/does/not/exist/ever")
	if err == nil {
		t.Fatal("expected error for nonexistent path")
	}
	if !strings.Contains(err.Error(), "ls") {
		t.Fatalf("expected command name in error, got: %v", err)
	}
}

func TestOutput_inDir(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	f := filepath.Join(dir, "marker.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := gitutil.Output(ctx, dir, "ls")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(out, "marker.txt") {
		t.Fatalf("expected file listing in output, got %q", out)
	}
}
