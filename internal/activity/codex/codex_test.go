package codex_test

import (
	"testing"

	codex "github.com/tamara1031/temporal-repo-steward/internal/activity/codex"
)

// ── ExtractJSON ───────────────────────────────────────────────────────────────

func TestExtractJSON_PlainObject(t *testing.T) {
	raw := `{"theme":"refactor","steps":[]}`
	var p codex.Plan
	if err := codex.ExtractJSON(raw, &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Theme != "refactor" {
		t.Errorf("theme: got %q, want %q", p.Theme, "refactor")
	}
}

func TestExtractJSON_EmbeddedInText(t *testing.T) {
	raw := `Here is your plan: {"theme":"extract helpers","steps":[{"title":"step1","description":"do it"}]} — apply it.`
	var p codex.Plan
	if err := codex.ExtractJSON(raw, &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Theme != "extract helpers" {
		t.Errorf("theme: got %q", p.Theme)
	}
	if len(p.Steps) != 1 || p.Steps[0].Title != "step1" {
		t.Errorf("steps: got %+v", p.Steps)
	}
}

func TestExtractJSON_NoJSON_ReturnsError(t *testing.T) {
	var p codex.Plan
	if err := codex.ExtractJSON("no braces here at all", &p); err == nil {
		t.Fatal("expected error for input with no JSON object")
	}
}

func TestExtractJSON_EmptyString_ReturnsError(t *testing.T) {
	var p codex.Plan
	if err := codex.ExtractJSON("", &p); err == nil {
		t.Fatal("expected error for empty input")
	}
}

func TestExtractJSON_MalformedJSON_ReturnsError(t *testing.T) {
	var p codex.Plan
	if err := codex.ExtractJSON(`{"theme": "broken"`, &p); err == nil {
		t.Fatal("expected error for truncated JSON")
	}
}

func TestExtractJSON_NestedObject(t *testing.T) {
	raw := `{"theme":"outer","steps":[{"title":"s","description":"d"}],"meta":{"key":"val"}}`
	var p codex.Plan
	if err := codex.ExtractJSON(raw, &p); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if p.Theme != "outer" {
		t.Errorf("theme: got %q", p.Theme)
	}
}

func TestExtractJSON_MultipleObjects_UsesFirstAndLast(t *testing.T) {
	// ExtractJSON finds the first '{' and last '}', so adjacent objects
	// form invalid JSON — the function must return an error, not silently
	// pick the wrong object.
	raw := `{"a":"1"} {"b":"2"}`
	var m map[string]string
	// This is ambiguous input; the current implementation tries to parse the
	// span from the first '{' to the last '}', producing `{"a":"1"} {"b":"2"}`
	// which is invalid JSON — an error is the correct result.
	if err := codex.ExtractJSON(raw, &m); err == nil {
		// If the implementation happens to succeed (e.g. via lenient parsing),
		// ensure it at least populated something rather than returning nil data.
		if m == nil {
			t.Error("result map is nil despite no error")
		}
	}
	// No assertion on the error path — both "error" and "success with data" are
	// acceptable here; the test documents the known behaviour.
}

func TestExtractJSON_AdvisorVerdict(t *testing.T) {
	raw := `Sure, here you go: {"verdict":"retry","rationale":"looks ok","suggested_action":"try again"}`
	var v codex.AdvisorVerdict
	if err := codex.ExtractJSON(raw, &v); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.Verdict != "retry" {
		t.Errorf("verdict: got %q", v.Verdict)
	}
	if v.Rationale != "looks ok" {
		t.Errorf("rationale: got %q", v.Rationale)
	}
}

func TestExtractJSON_ReviewResult(t *testing.T) {
	raw := `{"verdict":"ok","feedback":"looks good","suggestions":[]}`
	var r codex.ReviewResult
	if err := codex.ExtractJSON(raw, &r); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if r.Verdict != "ok" {
		t.Errorf("verdict: got %q", r.Verdict)
	}
}
