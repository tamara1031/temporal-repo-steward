package workspace_test

import (
	"context"
	"os"
	"testing"

	"github.com/tamara1031/temporal-repo-steward/internal/workspace"
)

func newTestManager(t *testing.T, root string) *workspace.Manager {
	t.Helper()
	m, err := workspace.NewManager(workspace.ManagerConfig{
		Root:     root,
		Token:    "token",
		BotName:  "bot",
		BotEmail: "bot@test.com",
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	return m
}

func TestNewManager_CreatesRoot(t *testing.T) {
	root := t.TempDir() + "/ws"
	m := newTestManager(t, root)
	if m == nil {
		t.Fatal("expected non-nil Manager")
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("root directory not created: %v", err)
	}
}

func TestNewManager_MissingSessionReturnsNotFound(t *testing.T) {
	m := newTestManager(t, t.TempDir())
	_, ok := m.Session("nonexistent-session")
	if ok {
		t.Error("expected ok==false for missing session")
	}
}

func TestNewManager_ShortSessionIDRejected(t *testing.T) {
	m := newTestManager(t, t.TempDir())
	_, _, err := m.GetOrCreate(context.Background(), "short", "owner/repo", "main")
	if err == nil {
		t.Error("expected error for session ID shorter than 8 chars")
	}
}
