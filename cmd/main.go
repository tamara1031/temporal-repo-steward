package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
	ghact "github.com/tamara1031/temporal-repo-steward/internal/activity/github"
	codexcli "github.com/tamara1031/temporal-repo-steward/internal/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/tamara1031/temporal-repo-steward/internal/workspace"
	"go.temporal.io/sdk/client"
	sdkworker "go.temporal.io/sdk/worker"
)

const taskQueue = "repo-steward"

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: parseLogLevel(getenv("LOG_LEVEL", "info")),
	})))

	tc, err := dialTemporal()
	if err != nil {
		slog.Error("temporal dial failed", "error", err)
		os.Exit(1)
	}
	defer tc.Close()

	mgr, err := workspace.NewManager(
		getenv("WORKSPACE_ROOT", "/workspaces"),
		mustGetenv("GITHUB_TOKEN"),
		getenv("GIT_BOT_NAME", "repo-steward-bot"),
		getenv("GIT_BOT_EMAIL", "repo-steward-bot@users.noreply.github.com"),
	)
	if err != nil {
		slog.Error("workspace manager init failed", "error", err)
		os.Exit(1)
	}

	cx := codexcli.NewClient(
		getenv("CODEX_BIN", "codex"),
		getenv("CODEX_MODEL", ""),
	)

	gitActs := &gitact.Activities{}

	tw := sdkworker.New(tc, taskQueue, sdkworker.Options{})

	tw.RegisterWorkflow(workflow.PeriodicRefactorWorkflow)
	tw.RegisterWorkflow(workflow.DesignPhaseWorkflow)
	tw.RegisterWorkflow(workflow.RefactorStepWorkflow)
	tw.RegisterWorkflow(workflow.RobustPRMergeWorkflow)

	tw.RegisterActivity(codexact.NewActivities(cx, mgr))
	tw.RegisterActivity(gitActs)
	tw.RegisterActivity(&ghact.Activities{})

	if err := tw.Start(); err != nil {
		slog.Error("worker start failed", "error", err)
		os.Exit(1)
	}
	defer tw.Stop()

	if getenv("REGISTER_SCHEDULE", "false") == "true" {
		if err := registerSchedule(tc); err != nil {
			slog.Warn("schedule registration failed", "error", err)
		}
	}

	slog.Info("repo-steward worker started", "taskQueue", taskQueue)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	slog.Info("shutting down")
}

func registerSchedule(tc client.Client) error {
	scheduleID := getenv("SCHEDULE_ID", "repo-steward-periodic-refactor")
	cronExpr := getenv("SCHEDULE_CRON", "0 3 * * 1")

	in := workflow.PeriodicRefactorInput{
		RepoFullName: mustGetenv("TARGET_REPO"),
		BaseBranch:   getenv("BASE_BRANCH", "main"),
		Brief:        mustGetenv("REFACTOR_BRIEF"),
		PRTitle:      getenv("PR_TITLE", "chore: automated refactor"),
		PRBody:       getenv("PR_BODY", "Automated refactoring pass by repo-steward."),
		AutoMerge:    getenv("AUTO_MERGE", "false") == "true",
	}

	_, err := tc.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: scheduleID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{cronExpr},
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow:  workflow.PeriodicRefactorWorkflow,
			TaskQueue: taskQueue,
			Args:      []interface{}{in},
		},
	})
	return err
}

func dialTemporal() (client.Client, error) {
	opts := client.Options{
		HostPort:  getenv("TEMPORAL_ADDRESS", "localhost:7233"),
		Namespace: getenv("TEMPORAL_NAMESPACE", "default"),
	}
	if getenv("TEMPORAL_TLS", "false") == "true" {
		opts.ConnectionOptions = client.ConnectionOptions{
			TLS: &tls.Config{MinVersion: tls.VersionTLS12},
		}
	}
	return client.Dial(opts)
}

func mustGetenv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic(fmt.Sprintf("required env var %q is not set", key))
	}
	return v
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseLogLevel(s string) slog.Level {
	var l slog.Level
	_ = l.UnmarshalText([]byte(s))
	return l
}
