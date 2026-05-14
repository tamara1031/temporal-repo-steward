package config_test

import (
	"log/slog"
	"testing"

	"github.com/tamara1031/temporal-repo-steward/internal/config"
)

// setEnv is a helper that sets env vars for the duration of a test and
// restores them when the test finishes.
func setEnv(t *testing.T, kvs map[string]string) {
	t.Helper()
	for k, v := range kvs {
		t.Setenv(k, v)
	}
}

func TestLoad_RequiresGithubToken(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error when GITHUB_TOKEN is missing")
	}
	if want := "GITHUB_TOKEN"; !contains(err.Error(), want) {
		t.Errorf("error %q should mention %q", err.Error(), want)
	}
}

func TestLoad_DefaultsApplied(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":      "tok-test",
		"TEMPORAL_ADDRESS":  "",
		"TEMPORAL_NAMESPACE": "",
		"TEMPORAL_TLS":      "",
		"WORKSPACE_ROOT":    "",
		"GIT_BOT_NAME":      "",
		"GIT_BOT_EMAIL":     "",
		"CODEX_BIN":         "",
		"REGISTER_SCHEDULE": "",
		"SCHEDULE_ID":       "",
		"SCHEDULE_CRON":     "",
		"BASE_BRANCH":       "",
		"PR_TITLE":          "",
		"PR_BODY":           "",
		"AUTO_MERGE":        "",
		"LOG_LEVEL":         "",
	})

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if got := cfg.Temporal.Address; got != "localhost:7233" {
		t.Errorf("Temporal.Address = %q, want localhost:7233", got)
	}
	if got := cfg.Temporal.Namespace; got != "default" {
		t.Errorf("Temporal.Namespace = %q, want default", got)
	}
	if cfg.Temporal.TLS {
		t.Error("Temporal.TLS should default to false")
	}
	if got := cfg.Workspace.Root; got != "/workspaces" {
		t.Errorf("Workspace.Root = %q, want /workspaces", got)
	}
	if got := cfg.Workspace.BotName; got != "repo-steward-bot" {
		t.Errorf("Workspace.BotName = %q, want repo-steward-bot", got)
	}
	if got := cfg.Workspace.BotEmail; got != "repo-steward-bot@users.noreply.github.com" {
		t.Errorf("Workspace.BotEmail = %q, want repo-steward-bot@users.noreply.github.com", got)
	}
	if got := cfg.Codex.Bin; got != "codex" {
		t.Errorf("Codex.Bin = %q, want codex", got)
	}
	if cfg.Schedule.Register {
		t.Error("Schedule.Register should default to false")
	}
	if got := cfg.Schedule.BaseBranch; got != "main" {
		t.Errorf("Schedule.BaseBranch = %q, want main", got)
	}
	if got := cfg.Log.Level; got != slog.LevelInfo {
		t.Errorf("Log.Level = %v, want INFO", got)
	}
}

func TestLoad_OverridesApplied(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":       "mytoken",
		"TEMPORAL_ADDRESS":   "myhost:7233",
		"TEMPORAL_NAMESPACE": "my-namespace",
		"TEMPORAL_TLS":       "true",
		"WORKSPACE_ROOT":     "/data/workspaces",
		"GIT_BOT_NAME":       "my-bot",
		"GIT_BOT_EMAIL":      "mybot@example.com",
		"CODEX_BIN":          "/usr/local/bin/codex",
		"CODEX_MODEL":        "gpt-4o",
		"LOG_LEVEL":          "debug",
	})

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	if cfg.Temporal.Address != "myhost:7233" {
		t.Errorf("Temporal.Address = %q, want myhost:7233", cfg.Temporal.Address)
	}
	if cfg.Temporal.Namespace != "my-namespace" {
		t.Errorf("Temporal.Namespace = %q, want my-namespace", cfg.Temporal.Namespace)
	}
	if !cfg.Temporal.TLS {
		t.Error("Temporal.TLS should be true")
	}
	if cfg.Workspace.Root != "/data/workspaces" {
		t.Errorf("Workspace.Root = %q, want /data/workspaces", cfg.Workspace.Root)
	}
	if cfg.Workspace.Token != "mytoken" {
		t.Errorf("Workspace.Token = %q, want mytoken", cfg.Workspace.Token)
	}
	if cfg.Workspace.BotName != "my-bot" {
		t.Errorf("Workspace.BotName = %q, want my-bot", cfg.Workspace.BotName)
	}
	if cfg.Workspace.BotEmail != "mybot@example.com" {
		t.Errorf("Workspace.BotEmail = %q, want mybot@example.com", cfg.Workspace.BotEmail)
	}
	if cfg.Codex.Bin != "/usr/local/bin/codex" {
		t.Errorf("Codex.Bin = %q, want /usr/local/bin/codex", cfg.Codex.Bin)
	}
	if cfg.Codex.Model != "gpt-4o" {
		t.Errorf("Codex.Model = %q, want gpt-4o", cfg.Codex.Model)
	}
	if cfg.Log.Level != slog.LevelDebug {
		t.Errorf("Log.Level = %v, want DEBUG", cfg.Log.Level)
	}
}

func TestLoad_ScheduleRequiresTargetRepo(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":      "tok",
		"REGISTER_SCHEDULE": "true",
		"REFACTOR_BRIEF":    "some brief",
		"TARGET_REPO":       "",
	})
	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error when TARGET_REPO missing with REGISTER_SCHEDULE=true")
	}
	if !contains(err.Error(), "TARGET_REPO") {
		t.Errorf("error %q should mention TARGET_REPO", err.Error())
	}
}

func TestLoad_ScheduleRequiresBrief(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":      "tok",
		"REGISTER_SCHEDULE": "true",
		"TARGET_REPO":       "owner/repo",
		"REFACTOR_BRIEF":    "",
	})
	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error when REFACTOR_BRIEF missing with REGISTER_SCHEDULE=true")
	}
	if !contains(err.Error(), "REFACTOR_BRIEF") {
		t.Errorf("error %q should mention REFACTOR_BRIEF", err.Error())
	}
}

func TestLoad_ScheduleRequiresBothFields(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":      "tok",
		"REGISTER_SCHEDULE": "true",
		"TARGET_REPO":       "",
		"REFACTOR_BRIEF":    "",
	})
	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error when both schedule fields are missing")
	}
	// Both problems must be reported in a single error.
	if !contains(err.Error(), "TARGET_REPO") {
		t.Errorf("error %q should mention TARGET_REPO", err.Error())
	}
	if !contains(err.Error(), "REFACTOR_BRIEF") {
		t.Errorf("error %q should mention REFACTOR_BRIEF", err.Error())
	}
}

func TestLoad_ScheduleValid(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN":      "tok",
		"REGISTER_SCHEDULE": "true",
		"TARGET_REPO":       "owner/repo",
		"REFACTOR_BRIEF":    "Clean up all the things",
		"AUTO_MERGE":        "true",
		"PR_TITLE":          "refactor: scheduled cleanup",
	})
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.Schedule.Register {
		t.Error("Schedule.Register should be true")
	}
	if cfg.Schedule.TargetRepo != "owner/repo" {
		t.Errorf("Schedule.TargetRepo = %q, want owner/repo", cfg.Schedule.TargetRepo)
	}
	if !cfg.Schedule.AutoMerge {
		t.Error("Schedule.AutoMerge should be true")
	}
	if cfg.Schedule.PRTitle != "refactor: scheduled cleanup" {
		t.Errorf("Schedule.PRTitle = %q", cfg.Schedule.PRTitle)
	}
}

func TestLoad_InvalidLogLevel(t *testing.T) {
	setEnv(t, map[string]string{
		"GITHUB_TOKEN": "tok",
		"LOG_LEVEL":    "notaLevel",
	})
	_, err := config.Load()
	if err == nil {
		t.Fatal("expected error for invalid LOG_LEVEL")
	}
	if !contains(err.Error(), "LOG_LEVEL") {
		t.Errorf("error %q should mention LOG_LEVEL", err.Error())
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(sub) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(sub); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
			return false
		}())
}
