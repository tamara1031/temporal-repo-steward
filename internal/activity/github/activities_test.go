package github

import "testing"

func TestClassifyChecks(t *testing.T) {
	cases := []struct {
		name        string
		checks      []statusCheck
		wantAllDone bool
		wantFailed  bool
		wantURLs    []string
	}{
		{
			name:        "empty list is not done",
			checks:      []statusCheck{},
			wantAllDone: false,
			wantFailed:  false,
		},
		{
			name:        "nil slice is not done",
			checks:      nil,
			wantAllDone: false,
			wantFailed:  false,
		},
		{
			name: "all completed success",
			checks: []statusCheck{
				{Status: "COMPLETED", Conclusion: "SUCCESS"},
				{Status: "COMPLETED", Conclusion: "SUCCESS"},
			},
			wantAllDone: true,
			wantFailed:  false,
		},
		{
			name: "one pending",
			checks: []statusCheck{
				{Status: "COMPLETED", Conclusion: "SUCCESS"},
				{Status: "IN_PROGRESS", Conclusion: ""},
			},
			wantAllDone: false,
			wantFailed:  false,
		},
		{
			name: "failure recorded",
			checks: []statusCheck{
				{Status: "COMPLETED", Conclusion: "FAILURE", DetailsURL: "https://example.com/runs/1"},
				{Status: "COMPLETED", Conclusion: "SUCCESS"},
			},
			wantAllDone: true,
			wantFailed:  true,
			wantURLs:    []string{"https://example.com/runs/1"},
		},
		{
			name: "timed_out treated as failure",
			checks: []statusCheck{
				{Status: "COMPLETED", Conclusion: "TIMED_OUT", DetailsURL: "https://example.com/runs/2"},
			},
			wantAllDone: true,
			wantFailed:  true,
			wantURLs:    []string{"https://example.com/runs/2"},
		},
		{
			name: "multiple failures collected",
			checks: []statusCheck{
				{Status: "COMPLETED", Conclusion: "FAILURE", DetailsURL: "https://example.com/runs/3"},
				{Status: "COMPLETED", Conclusion: "FAILURE", DetailsURL: "https://example.com/runs/4"},
			},
			wantAllDone: true,
			wantFailed:  true,
			wantURLs:    []string{"https://example.com/runs/3", "https://example.com/runs/4"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			allDone, anyFailed, urls := classifyChecks(c.checks)
			if allDone != c.wantAllDone {
				t.Errorf("allDone: got %v, want %v", allDone, c.wantAllDone)
			}
			if anyFailed != c.wantFailed {
				t.Errorf("anyFailed: got %v, want %v", anyFailed, c.wantFailed)
			}
			if len(urls) != len(c.wantURLs) {
				t.Errorf("failedURLs len: got %d, want %d — %v", len(urls), len(c.wantURLs), urls)
				return
			}
			for i, u := range urls {
				if u != c.wantURLs[i] {
					t.Errorf("failedURLs[%d]: got %q, want %q", i, u, c.wantURLs[i])
				}
			}
		})
	}
}

func TestRunIDFromURL(t *testing.T) {
	cases := []struct {
		url  string
		want string
	}{
		{
			url:  "https://github.com/owner/repo/actions/runs/1234567890",
			want: "1234567890",
		},
		{
			url:  "https://github.com/owner/repo/actions/runs/9876543210/jobs/111",
			want: "9876543210",
		},
		{
			url:  "https://github.com/owner/repo/actions/runs/42/",
			want: "42",
		},
		{
			url:  "https://example.com/no-runs-marker",
			want: "",
		},
		{
			url:  "",
			want: "",
		},
	}

	for _, c := range cases {
		got := runIDFromURL(c.url)
		if got != c.want {
			t.Errorf("runIDFromURL(%q) = %q; want %q", c.url, got, c.want)
		}
	}
}
