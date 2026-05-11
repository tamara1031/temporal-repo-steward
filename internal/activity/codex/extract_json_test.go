package codex

import (
	"testing"
)

func TestFirstJSONObject(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "bare JSON object",
			raw:  `{"theme":"foo","steps":[]}`,
			want: `{"theme":"foo","steps":[]}`,
		},
		{
			name: "JSON preceded by prose",
			raw:  `Here is the plan: {"theme":"bar"} Hope that helps!`,
			want: `{"theme":"bar"}`,
		},
		{
			name: "JSON in markdown code fence",
			raw:  "```json\n{\"theme\":\"baz\"}\n```",
			want: `{"theme":"baz"}`,
		},
		{
			name: "multiple JSON objects picks first",
			raw:  `{"a":1} some text {"b":2}`,
			want: `{"a":1}`,
		},
		{
			name: "nested object",
			raw:  `{"steps":[{"title":"s1","description":"d1"}]}`,
			want: `{"steps":[{"title":"s1","description":"d1"}]}`,
		},
		{
			name: "string value containing braces",
			raw:  `{"feedback":"use {curly} braces","verdict":"ok"}`,
			want: `{"feedback":"use {curly} braces","verdict":"ok"}`,
		},
		{
			name: "escaped quote inside string",
			raw:  `{"key":"value with \"quotes\" inside"}`,
			want: `{"key":"value with \"quotes\" inside"}`,
		},
		{
			name: "no JSON object",
			raw:  "no braces here",
			want: "",
		},
		{
			name: "empty input",
			raw:  "",
			want: "",
		},
		{
			name: "unclosed brace",
			raw:  `{"open":true`,
			want: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := firstJSONObject(tc.raw)
			if got != tc.want {
				t.Errorf("firstJSONObject(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestExtractJSON(t *testing.T) {
	t.Run("unmarshals first JSON object from prose-wrapped response", func(t *testing.T) {
		raw := `Great plan! {"theme":"refactor","steps":[]} Let me know if you need changes.`
		var p Plan
		if err := ExtractJSON(raw, &p); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.Theme != "refactor" {
			t.Errorf("theme = %q, want %q", p.Theme, "refactor")
		}
	})

	t.Run("multiple JSON objects uses first only", func(t *testing.T) {
		// Old algorithm (strings.Index + strings.LastIndex) would span both objects,
		// producing invalid JSON. New algorithm extracts only the first complete object.
		raw := `{"theme":"first","steps":[]} {"theme":"second","steps":[]}`
		var p Plan
		if err := ExtractJSON(raw, &p); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if p.Theme != "first" {
			t.Errorf("theme = %q, want %q", p.Theme, "first")
		}
	})

	t.Run("returns error when no JSON found", func(t *testing.T) {
		if err := ExtractJSON("no json here", &Plan{}); err == nil {
			t.Fatal("expected error, got nil")
		}
	})

	t.Run("returns error on invalid JSON structure", func(t *testing.T) {
		if err := ExtractJSON(`{"bad":}`, &Plan{}); err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}
