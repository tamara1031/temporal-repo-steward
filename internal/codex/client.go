package codex

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Client wraps the codex CLI binary.
type Client struct {
	bin     string
	model   string
	timeout time.Duration
}

func NewClient(bin, model string) *Client {
	if bin == "" {
		bin = "codex"
	}
	return &Client{
		bin:     bin,
		model:   model,
		timeout: 30 * time.Minute,
	}
}

type RunOptions struct {
	WorkDir  string
	Prompt   string
	Approval string // "suggest" | "auto-edit" | "full-auto"
}

func (c *Client) Run(ctx context.Context, opts RunOptions) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	args := []string{"--approval-mode", orDefault(opts.Approval, "full-auto")}
	if c.model != "" {
		args = append(args, "--model", c.model)
	}
	args = append(args, opts.Prompt)

	cmd := exec.CommandContext(ctx, c.bin, args...)
	cmd.Dir = opts.WorkDir

	var out bytes.Buffer
	var errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf

	if err := cmd.Run(); err != nil {
		stderr := strings.TrimSpace(errBuf.String())
		if stderr != "" {
			return "", fmt.Errorf("codex: %w\n%s", err, stderr)
		}
		return "", fmt.Errorf("codex: %w", err)
	}
	return strings.TrimSpace(out.String()), nil
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
