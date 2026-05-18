package model

import (
	"time"

	"github.com/google/uuid"
)

type Agent struct {
	AgentID        uuid.UUID         `db:"agent_id"        json:"agent_id"`
	AgentName      *string           `db:"agent_name"      json:"agent_name"`
	Model          string            `db:"model"           json:"model"`
	Prompt         *string           `db:"prompt"          json:"prompt"`
	HarnessID      string            `db:"harness_id"      json:"harness_id"`
	RepoURL        *string           `db:"repo_url"        json:"repo_url"`
	Branch         string            `db:"branch"          json:"branch"`
	EnvVars        map[string]string `db:"env_vars"        json:"env_vars"`
	ContainerPort  int               `db:"container_port"  json:"container_port"`
	SandboxStatus  string            `db:"sandbox_status"  json:"sandbox_status"`
	TaskName       *string           `db:"task_name"       json:"task_name"`
	SandboxURL     *string           `db:"sandbox_url"     json:"sandbox_url"`
	CreatedAt      time.Time         `db:"created_at"      json:"created_at"`
}

type Session struct {
	SessionID        uuid.UUID  `db:"session_id"         json:"session_id"`
	AgentID          uuid.UUID  `db:"agent_id"           json:"agent_id"`
	Status           string     `db:"status"             json:"status"`
	Phase            *string    `db:"phase"              json:"phase"`
	Title            *string    `db:"title"              json:"title"`
	HarnessSessionID *string    `db:"harness_session_id" json:"harness_session_id"`
	CreatedAt        time.Time  `db:"created_at"         json:"created_at"`
	LastSeenAt       *time.Time `db:"last_seen_at"       json:"last_seen_at"`
	StoppedAt        *time.Time `db:"stopped_at"         json:"stopped_at"`
}
