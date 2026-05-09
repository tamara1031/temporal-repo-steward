package github

import "testing"

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
