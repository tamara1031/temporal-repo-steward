package workspace

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/tamara1031/temporal-repo-steward/internal/gitutil"
)

const defaultSessionTTL = 24 * time.Hour

// ManagerConfig holds the credentials and identity used by Manager when
// cloning repositories and committing on behalf of the bot. Using a struct
// avoids the ambiguity of four positional string parameters that are easy
// to accidentally transpose.
type ManagerConfig struct {
	Root     string
	Token    string
	BotName  string
	BotEmail string
}

type Manager struct {
	root        string
	githubToken string
	botName     string
	botEmail    string

	mu       sync.Mutex
	sessions map[string]*Session
}

func NewManager(cfg ManagerConfig) (*Manager, error) {
	if err := os.MkdirAll(cfg.Root, 0o700); err != nil {
		return nil, fmt.Errorf("workspace root: %w", err)
	}
	return &Manager{
		root:        cfg.Root,
		githubToken: cfg.Token,
		botName:     cfg.BotName,
		botEmail:    cfg.BotEmail,
		sessions:    make(map[string]*Session),
	}, nil
}

// GetOrCreate returns an existing session or creates one by cloning the repo.
func (m *Manager) GetOrCreate(ctx context.Context, sessionID, repoFullName, baseBranch string) (*Session, bool, error) {
	if len(sessionID) < 8 {
		return nil, false, fmt.Errorf("session_id must be at least 8 characters")
	}

	m.mu.Lock()
	if s, ok := m.sessions[sessionID]; ok {
		s.Updated = time.Now()
		m.mu.Unlock()
		return s, false, nil
	}
	m.mu.Unlock()

	safeRepo := strings.ReplaceAll(repoFullName, "/", "_")
	ts := time.Now().UTC().Format("20060102-150405")
	workDir := filepath.Join(m.root, fmt.Sprintf("%s_%s_%s", safeRepo, ts, sessionID[:8]))
	branch := fmt.Sprintf("codex-session/%s/%s", ts, sessionID[:8])

	if err := m.clone(ctx, repoFullName, baseBranch, branch, workDir); err != nil {
		return nil, false, fmt.Errorf("clone: %w", err)
	}

	s := &Session{
		ID:           sessionID,
		RepoFullName: repoFullName,
		Branch:       branch,
		WorkDir:      workDir,
		Created:      time.Now(),
		Updated:      time.Now(),
	}

	m.mu.Lock()
	if existing, ok := m.sessions[sessionID]; ok {
		m.mu.Unlock()
		_ = os.RemoveAll(workDir)
		existing.Updated = time.Now()
		return existing, false, nil
	}
	m.sessions[sessionID] = s
	m.mu.Unlock()

	slog.Info("workspace created", "sessionID", sessionID, "workDir", workDir, "branch", branch)
	return s, true, nil
}

// Session returns an existing session by ID.
func (m *Manager) Session(sessionID string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	return s, ok
}

// Remove deletes a session's workspace and unregisters it.
func (m *Manager) Remove(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[sessionID]
	if !ok {
		return
	}
	delete(m.sessions, sessionID)
	if err := os.RemoveAll(s.WorkDir); err != nil {
		slog.Warn("workspace cleanup failed", "sessionID", sessionID, "error", err)
	}
	slog.Info("workspace removed", "sessionID", sessionID)
}

// CleanupOld removes sessions not accessed within maxAge.
// If maxAge is zero, defaultSessionTTL is used.
func (m *Manager) CleanupOld(maxAge time.Duration) {
	if maxAge == 0 {
		maxAge = defaultSessionTTL
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	for id, s := range m.sessions {
		if s.Updated.Before(cutoff) {
			delete(m.sessions, id)
			if err := os.RemoveAll(s.WorkDir); err != nil {
				slog.Warn("stale workspace cleanup failed", "sessionID", id, "error", err)
			}
			slog.Info("stale workspace cleaned up", "sessionID", id)
		}
	}
}

func (m *Manager) clone(ctx context.Context, repoFullName, baseBranch, branch, workDir string) error {
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return err
	}
	cloneURL := fmt.Sprintf("https://x-access-token:%s@github.com/%s.git", m.githubToken, repoFullName)
	if err := gitutil.Run(ctx, workDir, "git", "clone", "--branch="+baseBranch, cloneURL, "."); err != nil {
		return err
	}
	if err := gitutil.Run(ctx, workDir, "git", "config", "user.name", m.botName); err != nil {
		return err
	}
	if err := gitutil.Run(ctx, workDir, "git", "config", "user.email", m.botEmail); err != nil {
		return err
	}
	return gitutil.Run(ctx, workDir, "git", "checkout", "-b", branch)
}
