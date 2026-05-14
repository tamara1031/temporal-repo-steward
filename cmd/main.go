package main

import (
	"context"
	"crypto/tls"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	codexact "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
	gitact "github.com/tamara1031/temporal-repo-steward/internal/activity/git"
	ghact "github.com/tamara1031/temporal-repo-steward/internal/activity/github"
	codexcli "github.com/tamara1031/temporal-repo-steward/internal/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/config"
	"github.com/tamara1031/temporal-repo-steward/internal/workflow"
	"github.com/tamara1031/temporal-repo-steward/internal/workspace"
	"go.temporal.io/sdk/client"
	sdkworker "go.temporal.io/sdk/worker"
)

const taskQueue = "repo-steward"

func main() {
	cfg, err := config.Load()
	if err != nil {
		// Write to stderr before the structured logger is configured.
		_, _ = os.Stderr.WriteString("config error: " + err.Error() + "\n")
		os.Exit(1)
	}

	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: cfg.Log.Level,
	})))

	tc, err := dialTemporal(cfg.Temporal)
	if err != nil {
		slog.Error("temporal dial failed", "error", err)
		os.Exit(1)
	}
	defer tc.Close()

	mgr, err := workspace.NewManager(workspace.ManagerConfig{
		Root:     cfg.Workspace.Root,
		Token:    cfg.Workspace.Token,
		BotName:  cfg.Workspace.BotName,
		BotEmail: cfg.Workspace.BotEmail,
	})
	if err != nil {
		slog.Error("workspace manager init failed", "error", err)
		os.Exit(1)
	}

	cx := codexcli.NewClient(cfg.Codex.Bin, cfg.Codex.Model)

	gitActs := &gitact.Activities{
		BotName:  cfg.Workspace.BotName,
		BotEmail: cfg.Workspace.BotEmail,
		Token:    cfg.Workspace.Token,
	}

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

	if cfg.Schedule.Register {
		if err := registerSchedule(tc, cfg.Schedule); err != nil {
			slog.Warn("schedule registration failed", "error", err)
		}
	}

	slog.Info("repo-steward worker started", "taskQueue", taskQueue)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	slog.Info("shutting down")
}

func registerSchedule(tc client.Client, s config.ScheduleConfig) error {
	in := workflow.PeriodicRefactorInput{
		RepoFullName: s.TargetRepo,
		BaseBranch:   s.BaseBranch,
		Brief:        s.Brief,
		PRTitle:      s.PRTitle,
		PRBody:       s.PRBody,
		AutoMerge:    s.AutoMerge,
	}

	_, err := tc.ScheduleClient().Create(context.Background(), client.ScheduleOptions{
		ID: s.ID,
		Spec: client.ScheduleSpec{
			CronExpressions: []string{s.CronExpr},
		},
		Action: &client.ScheduleWorkflowAction{
			Workflow:  workflow.PeriodicRefactorWorkflow,
			TaskQueue: taskQueue,
			Args:      []interface{}{in},
		},
	})
	return err
}

func dialTemporal(t config.TemporalConfig) (client.Client, error) {
	opts := client.Options{
		HostPort:  t.Address,
		Namespace: t.Namespace,
	}
	if t.TLS {
		opts.ConnectionOptions = client.ConnectionOptions{
			TLS: &tls.Config{MinVersion: tls.VersionTLS12},
		}
	}
	return client.Dial(opts)
}
