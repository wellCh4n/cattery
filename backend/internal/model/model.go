package model

import (
	"time"

	"github.com/google/uuid"
)

type Harness struct {
	HarnessID     uuid.UUID         `db:"harness_id"     json:"harness_id"`
	HarnessName   *string           `db:"harness_name"   json:"harness_name"`
	Model         string            `db:"model"          json:"model"`
	Type          string            `db:"type"           json:"type"`
	EnvVars       map[string]string `db:"env_vars"       json:"env_vars"`
	SandboxStatus string            `db:"sandbox_status" json:"sandbox_status"`
	TaskName      *string           `db:"task_name"      json:"task_name"`
	SandboxURL    *string           `db:"sandbox_url"    json:"sandbox_url"`
	CreatedAt     time.Time         `db:"created_at"     json:"created_at"`
}

type Session struct {
	SessionID        uuid.UUID  `db:"session_id"         json:"session_id"`
	HarnessID        uuid.UUID  `db:"harness_id"         json:"harness_id"`
	Status           string     `db:"status"             json:"status"`
	Phase            *string    `db:"phase"              json:"phase"`
	Title            *string    `db:"title"              json:"title"`
	HarnessSessionID *string    `db:"harness_session_id" json:"harness_session_id"`
	CreatedAt        time.Time  `db:"created_at"         json:"created_at"`
	LastSeenAt       *time.Time `db:"last_seen_at"       json:"last_seen_at"`
	StoppedAt        *time.Time `db:"stopped_at"         json:"stopped_at"`
}
