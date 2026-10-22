package model

import (
	"time"

	"github.com/google/uuid"
)

const (
	AccessOwner  = "owner"
	AccessMember = "member"
)

type Project struct {
	ProjectID   uuid.UUID `db:"project_id"    json:"project_id"`
	OwnerUserID uuid.UUID `db:"owner_user_id" json:"owner_user_id"`
	ProjectName *string   `db:"project_name"  json:"project_name"`
	// SandboxStatus tracks the project's single agent sandbox:
	// idle | starting | ready | failed.
	SandboxStatus string    `db:"sandbox_status" json:"sandbox_status"`
	CreatedAt     time.Time `db:"created_at"    json:"created_at"`
}

type ProjectAccess struct {
	Project       *Project `json:"project"`
	AccessRole    string   `json:"access_role"`
	OwnerUsername string   `json:"owner_username"`
}

type ProjectMember struct {
	ProjectID uuid.UUID `db:"project_id" json:"project_id"`
	UserID    uuid.UUID `db:"user_id"    json:"user_id"`
	Username  string    `db:"username"   json:"username"`
	Role      string    `db:"role"       json:"role"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

type User struct {
	UserID       uuid.UUID  `db:"user_id"       json:"user_id"`
	Username     string     `db:"username"      json:"username"`
	PasswordHash string     `db:"password_hash" json:"-"`
	IsAdmin      bool       `db:"is_admin"      json:"is_admin"`
	CreatedAt    time.Time  `db:"created_at"    json:"created_at"`
	LastLoginAt  *time.Time `db:"last_login_at" json:"last_login_at"`
}

// Session is one conversation with the agent in its project's sandbox. The
// agent keys its transcript by SessionID, so there is no separate agent-side id.
type Session struct {
	SessionID uuid.UUID `db:"session_id"   json:"session_id"`
	ProjectID uuid.UUID `db:"project_id"   json:"project_id"`
	// Legacy sessions have no creator. The username snapshot survives account deletion.
	CreatedByUserID   *uuid.UUID `db:"created_by_user_id" json:"created_by_user_id"`
	CreatedByUsername *string    `db:"created_by_username" json:"created_by_username"`
	Model             string     `db:"model"        json:"model"`
	// Effort is the thinking effort (a pi thinking level); empty means the
	// model provider's default.
	Effort      string     `db:"effort"       json:"effort"`
	Status      string     `db:"status"       json:"status"`
	Phase       *string    `db:"phase"        json:"phase"`
	Title       *string    `db:"title"        json:"title"`
	TitleManual bool       `db:"title_manual" json:"title_manual"`
	CreatedAt   time.Time  `db:"created_at"   json:"created_at"`
	LastSeenAt  *time.Time `db:"last_seen_at" json:"last_seen_at"`
}

// Terminal is a shared tmux session in a project's agent container.
type Terminal struct {
	TerminalID        uuid.UUID  `db:"terminal_id" json:"terminal_id"`
	ProjectID         uuid.UUID  `db:"project_id" json:"project_id"`
	Title             string     `db:"title" json:"title"`
	CreatedByUserID   *uuid.UUID `db:"created_by_user_id" json:"created_by_user_id"`
	CreatedByUsername *string    `db:"created_by_username" json:"created_by_username"`
	CreatedAt         time.Time  `db:"created_at" json:"created_at"`
}
