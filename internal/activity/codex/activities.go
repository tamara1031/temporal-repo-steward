package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/tamara1031/temporal-repo-steward/internal/codex"
	"github.com/tamara1031/temporal-repo-steward/internal/gitutil"
	"github.com/tamara1031/temporal-repo-steward/internal/workspace"
	"go.temporal.io/sdk/activity"
)

// Step is a single refactoring step.
type Step struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

// Plan is the output of the design phase.
type Plan struct {
	Theme string `json:"theme"`
	Steps []Step `json:"steps"`
}

// DesignInput is the input to DesignActivity.
type DesignInput struct {
	SessionID  string `json:"session_id,omitempty"`
	Repo       string `json:"repo"`
	BaseBranch string `json:"base_branch"`
	Brief      string `json:"brief"`
}

// DesignResult is the output of DesignActivity.
type DesignResult struct {
	SessionID       string `json:"session_id"`
	Plan            Plan   `json:"plan"`
	ContextArtifact string `json:"context_artifact"`
	WorkDir         string `json:"work_dir"`
	Branch          string `json:"branch"`
}

// ImplementInput is the input to ImplementActivity.
type ImplementInput struct {
	SessionID       string `json:"session_id"`
	Step            Step   `json:"step"`
	ContextArtifact string `json:"context_artifact,omitempty"`
}

// ImplementResult is the output of ImplementActivity.
type ImplementResult struct {
	SessionID  string `json:"session_id"`
	DiffStat   string `json:"diff_stat"`
	HasChanges bool   `json:"has_changes"`
	CommitSHA  string `json:"commit_sha"`
}

// ReviewInput is the input to ReviewActivity.
type ReviewInput struct {
	SessionID       string `json:"session_id"`
	Concern         string `json:"concern"` // "design" | "correctness" | "quality" | "security"
	Diff            string `json:"diff,omitempty"`
	ContextArtifact string `json:"context_artifact,omitempty"`
}

// ReviewResult is the output of ReviewActivity.
type ReviewResult struct {
	Verdict     string   `json:"verdict"` // "ok" | "suggest" | "critical_block"
	Feedback    string   `json:"feedback"`
	Suggestions []string `json:"suggestions"`
}

// ChatInput is the input to ChatActivity.
type ChatInput struct {
	Message         string `json:"message"`
	SessionID       string `json:"session_id,omitempty"`
	Context         string `json:"context,omitempty"`
	ContextArtifact string `json:"context_artifact,omitempty"` // path to a file whose content is prepended to Message
}

// ChatResult is the output of ChatActivity.
type ChatResult struct {
	SessionID string `json:"session_id"`
	Response  string `json:"response"`
}

// AdvisorVerdict is the structured output of ConsultAdvisorActivity.
type AdvisorVerdict struct {
	Verdict         string `json:"verdict"` // "retry" | "abort" | "change-strategy"
	Rationale       string `json:"rationale"`
	SuggestedAction string `json:"suggested_action"`
}

// Activities holds direct codex CLI + workspace dependencies.
type Activities struct {
	cx  *codex.Client
	mgr *workspace.Manager
}

func NewActivities(cx *codex.Client, mgr *workspace.Manager) *Activities {
	return &Activities{cx: cx, mgr: mgr}
}

// DesignActivity clones the repo and generates a refactoring plan.
func (a *Activities) DesignActivity(ctx context.Context, in DesignInput) (DesignResult, error) {
	activity.RecordHeartbeat(ctx, "design: cloning workspace")

	sessionID := in.SessionID
	if sessionID == "" {
		sessionID = newSessionID()
	}
	if in.BaseBranch == "" {
		in.BaseBranch = "main"
	}

	s, _, err := a.mgr.GetOrCreate(ctx, sessionID, in.Repo, in.BaseBranch)
	if err != nil {
		return DesignResult{}, fmt.Errorf("workspace: %w", err)
	}

	activity.RecordHeartbeat(ctx, "design: running codex")

	prompt := fmt.Sprintf(
		"Analyze this repository and create a concrete refactoring plan.\n"+
			"Objective: %s\n\n"+
			"Respond with JSON only, in this exact shape:\n"+
			`{"theme":"<one-line summary>","steps":[{"title":"<step title>","description":"<what to do>"},...]}`,
		in.Brief,
	)

	raw, err := a.cx.Run(ctx, codex.RunOptions{WorkDir: s.WorkDir, Prompt: prompt})
	if err != nil {
		return DesignResult{}, fmt.Errorf("codex: %w", err)
	}

	var plan Plan
	if err := ExtractJSON(raw, &plan); err != nil {
		plan = Plan{Theme: in.Brief}
	}

	artifact := s.WorkDir + "/.codex-context.json"
	_ = os.WriteFile(artifact, []byte(raw), 0o644)

	slog.Info("design complete", "sessionID", sessionID, "steps", len(plan.Steps))
	return DesignResult{
		SessionID:       sessionID,
		Plan:            plan,
		ContextArtifact: artifact,
		WorkDir:         s.WorkDir,
		Branch:          s.Branch,
	}, nil
}

// ImplementActivity applies a single refactoring step.
func (a *Activities) ImplementActivity(ctx context.Context, in ImplementInput) (ImplementResult, error) {
	activity.RecordHeartbeat(ctx, "implement: running codex")

	s, ok := a.mgr.Session(in.SessionID)
	if !ok {
		return ImplementResult{}, fmt.Errorf("session not found: %s", in.SessionID)
	}

	ctxText := ""
	if in.ContextArtifact != "" {
		data, _ := os.ReadFile(in.ContextArtifact)
		ctxText = string(data)
	}

	prompt := fmt.Sprintf(
		"Implement the following refactoring step. Edit the files in the working directory.\n\n"+
			"Step: %s\n"+
			"Description: %s\n\n"+
			"%s",
		in.Step.Title,
		in.Step.Description,
		optContext(ctxText),
	)

	shaBefore, _ := gitutil.Output(ctx, s.WorkDir, "git", "rev-parse", "HEAD")

	if _, err := a.cx.Run(ctx, codex.RunOptions{WorkDir: s.WorkDir, Prompt: prompt}); err != nil {
		return ImplementResult{}, fmt.Errorf("codex: %w", err)
	}

	shaAfter, _ := gitutil.Output(ctx, s.WorkDir, "git", "rev-parse", "HEAD")
	commitSHA := strings.TrimSpace(shaAfter)
	hasChanges := strings.TrimSpace(shaBefore) != commitSHA

	var diffStat string
	if hasChanges {
		diffStat, _ = gitutil.Output(ctx, s.WorkDir, "git", "diff", "--stat", "HEAD~1", "HEAD")
	} else {
		_ = gitutil.Run(ctx, s.WorkDir, "git", "add", "-A")
		diffStat, _ = gitutil.Output(ctx, s.WorkDir, "git", "diff", "--cached", "--stat")
		hasChanges = strings.TrimSpace(diffStat) != ""
		if hasChanges {
			_ = gitutil.Run(ctx, s.WorkDir, "git", "commit", "-m", fmt.Sprintf("refactor: %s", in.Step.Title))
			sha, _ := gitutil.Output(ctx, s.WorkDir, "git", "rev-parse", "HEAD")
			commitSHA = strings.TrimSpace(sha)
		}
	}

	slog.Info("implement complete", "sessionID", in.SessionID, "hasChanges", hasChanges, "commitSHA", commitSHA)
	return ImplementResult{
		SessionID:  in.SessionID,
		DiffStat:   strings.TrimSpace(diffStat),
		HasChanges: hasChanges,
		CommitSHA:  commitSHA,
	}, nil
}

// ReviewActivity reviews a code change for a specific concern.
func (a *Activities) ReviewActivity(ctx context.Context, in ReviewInput) (ReviewResult, error) {
	activity.RecordHeartbeat(ctx, "review: running codex")

	s, ok := a.mgr.Session(in.SessionID)
	if !ok {
		return ReviewResult{}, fmt.Errorf("session not found: %s", in.SessionID)
	}

	diff := in.Diff
	if diff == "" {
		diff, _ = gitutil.Output(ctx, s.WorkDir, "git", "diff", "HEAD~1", "HEAD")
	}

	ctxText := ""
	if in.ContextArtifact != "" {
		data, _ := os.ReadFile(in.ContextArtifact)
		ctxText = string(data)
	}

	prompt := fmt.Sprintf(
		"Review the following code change for %s concerns.\n\n"+
			"Respond with JSON only:\n"+
			`{"verdict":"ok|suggest|critical_block","feedback":"<explanation>","suggestions":["<suggestion>",...]}` + "\n\n"+
			"Diff:\n%s\n\n%s",
		in.Concern,
		diff,
		optContext(ctxText),
	)

	raw, err := a.cx.Run(ctx, codex.RunOptions{WorkDir: s.WorkDir, Prompt: prompt})
	if err != nil {
		return ReviewResult{}, fmt.Errorf("codex: %w", err)
	}

	var result ReviewResult
	if err := ExtractJSON(raw, &result); err != nil {
		result = ReviewResult{Verdict: "suggest", Feedback: raw}
	}

	slog.Info("review complete", "verdict", result.Verdict, "concern", in.Concern)
	return result, nil
}

// ChatActivity runs a general-purpose codex prompt, optionally within a session workspace.
func (a *Activities) ChatActivity(ctx context.Context, in ChatInput) (ChatResult, error) {
	activity.RecordHeartbeat(ctx, "chat: running codex")

	sessionID := in.SessionID
	if sessionID == "" {
		sessionID = newSessionID()
	}

	ctxText := in.Context
	if in.ContextArtifact != "" {
		if data, err := os.ReadFile(in.ContextArtifact); err == nil {
			ctxText = string(data)
		}
	}
	prompt := in.Message
	if ctxText != "" {
		prompt = ctxText + "\n\n" + in.Message
	}

	workDir := ""
	if in.SessionID != "" {
		if s, ok := a.mgr.Session(in.SessionID); ok {
			workDir = s.WorkDir
		}
	}

	result, err := a.cx.Run(ctx, codex.RunOptions{WorkDir: workDir, Prompt: prompt})
	if err != nil {
		return ChatResult{}, fmt.Errorf("codex: %w", err)
	}
	return ChatResult{SessionID: sessionID, Response: result}, nil
}

// ConsultAdvisorActivity asks codex for a structured verdict at a decision gate.
func (a *Activities) ConsultAdvisorActivity(ctx context.Context, summary string) (AdvisorVerdict, error) {
	activity.RecordHeartbeat(ctx, "consulting advisor")

	prompt := `You are an advisor. Respond with JSON only: {"verdict":"retry|abort|change-strategy","rationale":"...","suggested_action":"..."}.` +
		"\n\n" + summary

	raw, err := a.cx.Run(ctx, codex.RunOptions{Prompt: prompt})
	if err != nil {
		return AdvisorVerdict{}, fmt.Errorf("codex: %w", err)
	}

	var verdict AdvisorVerdict
	if err := ExtractJSON(raw, &verdict); err != nil {
		return AdvisorVerdict{Verdict: "retry", Rationale: raw}, nil
	}

	slog.Info("advisor verdict", "verdict", verdict.Verdict)
	return verdict, nil
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

func newSessionID() string {
	return fmt.Sprintf("sess-%d", time.Now().UnixNano())
}

func optContext(ctx string) string {
	if ctx == "" {
		return ""
	}
	return "Context:\n" + ctx
}

// ExtractJSON extracts the first complete JSON object from raw and unmarshals it
// into v. It uses bracket-depth counting so it correctly handles responses where
// the LLM includes multiple JSON objects or surrounding prose.
func ExtractJSON(raw string, v any) error {
	candidate := firstJSONObject(raw)
	if candidate == "" {
		return fmt.Errorf("no JSON object found in response")
	}
	return json.Unmarshal([]byte(candidate), v)
}

// firstJSONObject returns the first syntactically complete JSON object from raw
// by tracking brace depth and string boundaries (including escape sequences).
// Returns "" when no complete object is found.
func firstJSONObject(raw string) string {
	start := -1
	depth := 0
	inString := false
	escape := false
	for i, ch := range raw {
		if escape {
			escape = false
			continue
		}
		if ch == '\\' && inString {
			escape = true
			continue
		}
		if ch == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		switch ch {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			depth--
			if depth == 0 && start >= 0 {
				return raw[start : i+1]
			}
		}
	}
	return ""
}
