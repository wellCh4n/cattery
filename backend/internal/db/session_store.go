package db

import (
	"context"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const sessionColumns = `session_id, project_id, created_by_user_id, created_by_username, model, effort, status, phase, title, title_manual, created_at, last_seen_at`

type SessionStore struct{ db *sqlx.DB }

func NewSessionStore(db *sqlx.DB) *SessionStore { return &SessionStore{db} }

func (s *SessionStore) Create(ctx context.Context, sess *model.Session, creatorID uuid.UUID) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO sessions (session_id, project_id, model, effort, status, title, created_by_user_id, created_by_username)
		SELECT $1, $2, $3, $4, $5, $6, user_id, username FROM users WHERE user_id=$7
		RETURNING created_at, created_by_user_id, created_by_username`,
		sess.SessionID, sess.ProjectID, sess.Model, sess.Effort, sess.Status, sess.Title, creatorID,
	).Scan(&sess.CreatedAt, &sess.CreatedByUserID, &sess.CreatedByUsername)
}

func (s *SessionStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Session, error) {
	var sess model.Session
	err := s.db.QueryRowxContext(ctx,
		`SELECT `+sessionColumns+` FROM sessions WHERE session_id=$1`, id,
	).StructScan(&sess)
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *SessionStore) ListByProject(ctx context.Context, projectID uuid.UUID) ([]*model.Session, error) {
	var sessions []*model.Session
	err := s.db.SelectContext(ctx, &sessions,
		`SELECT `+sessionColumns+` FROM sessions WHERE project_id=$1 ORDER BY COALESCE(last_seen_at, created_at) DESC, created_at DESC, session_id ASC`, projectID,
	)
	return sessions, err
}

func (s *SessionStore) UpdateStatus(ctx context.Context, id uuid.UUID, status, phase string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET status=$1, phase=$2 WHERE session_id=$3`,
		status, phase, id,
	)
	return err
}

func (s *SessionStore) MarkSeen(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sessions SET last_seen_at=NOW() WHERE session_id=$1`, id)
	return err
}

func (s *SessionStore) UpdateModel(ctx context.Context, id uuid.UUID, model, effort string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET model=$1, effort=$2 WHERE session_id=$3`, model, effort, id,
	)
	return err
}

// HardDelete removes the row entirely. Caller is responsible for first aborting
// the agent-side run so we don't leave it going.
func (s *SessionStore) HardDelete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE session_id=$1`, id)
	return err
}

// SyncTitle serializes native-name writes and the UI projection with a row lock,
// including across backend replicas. A nil title repairs the native name from
// the current projection on registration. Manual titles reject automatic proposals.
func (s *SessionStore) SyncTitle(ctx context.Context, id uuid.UUID, title *string, manual bool, syncName func(string) (string, error)) (string, bool, error) {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	var current *string
	var isManual bool
	if err := tx.QueryRowContext(ctx, `SELECT title, title_manual FROM sessions WHERE session_id=$1 FOR UPDATE`, id).Scan(&current, &isManual); err != nil {
		return "", false, err
	}
	if title != nil && !manual && isManual {
		return "", false, nil
	}
	name := ""
	if current != nil {
		name = *current
	}
	if title != nil {
		name = *title
	}
	normalized, err := syncName(name)
	if err != nil {
		return "", false, err
	}
	if title != nil || current != nil || normalized != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET title=$1, title_manual=$2 WHERE session_id=$3`, normalized, isManual || manual, id); err != nil {
			return "", false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return normalized, true, nil
}
