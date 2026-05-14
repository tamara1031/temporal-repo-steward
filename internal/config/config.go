// Package config centralises all runtime configuration for repo-steward.
// Configuration is sourced exclusively from environment variables so that
// the binary stays 12-factor compliant. Call Load() once at startup; it
// returns an error that lists every missing required variable so operators
// see all problems in a single message rather than discovering them one by one.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
)

// Config is the validated, fully-typed configuration for the worker process.
type Config struct {
	Log      LogConfig
	Temporal TemporalConfig
	Workspace WorkspaceConfig
	Codex    CodexConfig
	Schedule ScheduleConfig
}

// LogConfig controls structured logging behaviour.
type LogConfig struct {
	Level slog.Level
}

// TemporalConfig holds connection details for the Temporal cluster.
type TemporalConfig struct {
	Address   string // TEMPORAL_ADDRESS  (default: localhost:7233)
	Namespace string // TEMPORAL_NAMESPACE (default: default)
	TLS       bool   // TEMPORAL_TLS      (default: false)
}

// WorkspaceConfig carries credentials and identity used when cloning repos
// and making git commits on behalf of the bot.
type WorkspaceConfig struct {
	Root     string // WORKSPACE_ROOT  (default: /workspaces)
	Token    string // GITHUB_TOKEN    (required)
	BotName  string // GIT_BOT_NAME    (default: repo-steward-bot)
	BotEmail string // GIT_BOT_EMAIL   (default: repo-steward-bot@users.noreply.github.com)
}

// CodexConfig describes how to invoke the external codex CLI.
type CodexConfig struct {
	Bin   string // CODEX_BIN   (default: codex)
	Model string // CODEX_MODEL (optional)
}

// ScheduleConfig controls optional Temporal schedule registration.
// The fields TargetRepo and Brief are required only when Register is true.
type ScheduleConfig struct {
	Register   bool   // REGISTER_SCHEDULE (default: false)
	ID         string // SCHEDULE_ID       (default: repo-steward-periodic-refactor)
	CronExpr   string // SCHEDULE_CRON     (default: 0 3 * * 1)
	TargetRepo string // TARGET_REPO       (required when Register=true)
	BaseBranch string // BASE_BRANCH       (default: main)
	Brief      string // REFACTOR_BRIEF    (required when Register=true)
	PRTitle    string // PR_TITLE          (default: chore: automated refactor)
	PRBody     string // PR_BODY           (default: Automated refactoring pass by repo-steward.)
	AutoMerge  bool   // AUTO_MERGE        (default: false)
}

// Load reads all configuration from environment variables, applies defaults,
// and validates required fields. It returns the first error that collects
// every validation failure so the operator can fix them all at once.
func Load() (*Config, error) {
	cfg := &Config{
		Temporal: TemporalConfig{
			Address:   getenv("TEMPORAL_ADDRESS", "localhost:7233"),
			Namespace: getenv("TEMPORAL_NAMESPACE", "default"),
			TLS:       getenv("TEMPORAL_TLS", "false") == "true",
		},
		Workspace: WorkspaceConfig{
			Root:     getenv("WORKSPACE_ROOT", "/workspaces"),
			Token:    os.Getenv("GITHUB_TOKEN"),
			BotName:  getenv("GIT_BOT_NAME", "repo-steward-bot"),
			BotEmail: getenv("GIT_BOT_EMAIL", "repo-steward-bot@users.noreply.github.com"),
		},
		Codex: CodexConfig{
			Bin:   getenv("CODEX_BIN", "codex"),
			Model: os.Getenv("CODEX_MODEL"),
		},
		Schedule: ScheduleConfig{
			Register:   getenv("REGISTER_SCHEDULE", "false") == "true",
			ID:         getenv("SCHEDULE_ID", "repo-steward-periodic-refactor"),
			CronExpr:   getenv("SCHEDULE_CRON", "0 3 * * 1"),
			TargetRepo: os.Getenv("TARGET_REPO"),
			BaseBranch: getenv("BASE_BRANCH", "main"),
			Brief:      os.Getenv("REFACTOR_BRIEF"),
			PRTitle:    getenv("PR_TITLE", "chore: automated refactor"),
			PRBody:     getenv("PR_BODY", "Automated refactoring pass by repo-steward."),
			AutoMerge:  getenv("AUTO_MERGE", "false") == "true",
		},
	}

	var lvl slog.Level
	raw := getenv("LOG_LEVEL", "info")
	if err := lvl.UnmarshalText([]byte(raw)); err != nil {
		return nil, fmt.Errorf("invalid LOG_LEVEL %q: %w", raw, err)
	}
	cfg.Log.Level = lvl

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// validate accumulates all missing-required-field errors and returns them
// as a single error so the operator gets a complete picture at startup.
func (c *Config) validate() error {
	var missing []string

	if c.Workspace.Token == "" {
		missing = append(missing, "GITHUB_TOKEN")
	}
	if c.Schedule.Register {
		if c.Schedule.TargetRepo == "" {
			missing = append(missing, "TARGET_REPO (required when REGISTER_SCHEDULE=true)")
		}
		if c.Schedule.Brief == "" {
			missing = append(missing, "REFACTOR_BRIEF (required when REGISTER_SCHEDULE=true)")
		}
	}

	if len(missing) == 0 {
		return nil
	}
	return errors.New("missing required environment variables: " + strings.Join(missing, ", "))
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
