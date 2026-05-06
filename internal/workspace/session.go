package workspace

import "time"

// Session represents an isolated workspace for a single coding session.
type Session struct {
	ID           string
	RepoFullName string
	Branch       string
	WorkDir      string
	Created      time.Time
	Updated      time.Time
}
