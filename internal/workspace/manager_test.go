package workspace_test

import (
	"context"
	"os"
	"testing"

	"github.com/tamara1031/temporal-repo-steward/internal/workspace"
)

func TestNewManager_CreatesRoot(t *testing.T) {
	root := t.TempDir() + "/ws"
	m, err := workspace.NewManager(root, "token", "bot", "bot@test.com")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	if m == nil {
		t.Fatal("expected non-nil Manager")
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("root directory not created: %v", err)
	}
}

func TestNewManager_MissingSessionReturnsNotFound(t *testing.T) {
	root := t.TempDir()
	m, err := workspace.NewManager(root, "token", "bot", "bot@test.com")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	_, ok := m.Session("nonexistent-session")
	if ok {
		t.Error("expected ok==false for missing session")
	}
}

func TestNewManager_ShortSessionIDRejected(t *testing.T) {
	root := t.TempDir()
	m, err := workspace.NewManager(root, "token", "bot", "bot@test.com")
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	_, _, err = m.GetOrCreate(context.Background(), "short", "owner/repo", "main")
	if err == nil {
		t.Error("expected error for session ID shorter than 8 chars")
	}
}
