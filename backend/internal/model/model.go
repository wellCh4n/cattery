package model

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
)

type Harness struct {
	HarnessID     uuid.UUID         `db:"harness_id"     json:"harness_id"`
	OwnerUserID   uuid.UUID         `db:"owner_user_id"  json:"owner_user_id"`
	HarnessName   *string           `db:"harness_name"   json:"harness_name"`
	Model         string            `db:"model"          json:"model"`
	Type          string            `db:"type"           json:"type"`
	EnvVars       map[string]string `db:"env_vars"       json:"env_vars"`
	SandboxStatus string            `db:"sandbox_status" json:"sandbox_status"`
	TaskName      *string           `db:"task_name"      json:"task_name"`
	SandboxURL    *string           `db:"sandbox_url"    json:"sandbox_url"`
	CreatedAt     time.Time         `db:"created_at"     json:"created_at"`
}

type User struct {
	UserID       uuid.UUID  `db:"user_id"       json:"user_id"`
	Username     string     `db:"username"      json:"username"`
	PasswordHash string     `db:"password_hash" json:"-"`
	IsAdmin      bool       `db:"is_admin"      json:"is_admin"`
	CreatedAt    time.Time  `db:"created_at"    json:"created_at"`
	LastLoginAt  *time.Time `db:"last_login_at" json:"last_login_at"`
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

var ModelProviders = map[string]string{
	"claude-sonnet-4-6": ProviderAnthropic,
	"claude-opus-4-6":   ProviderAnthropic,
	"claude-opus-4-7":   ProviderAnthropic,
	"gpt-5.4":           ProviderOpenAI,
	"gpt-5.5":           ProviderOpenAI,
}

// ProviderForModel returns the canonical provider family for configured model IDs.
func ProviderForModel(modelID string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(modelID))
	if provider, ok := ModelProviders[normalized]; ok {
		return provider, true
	}
	return ProviderOpenAI, false
}
