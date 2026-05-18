package db

import (
	"context"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const sessionColumns = `session_id, agent_id, status, phase, harness_session_id, created_at, last_seen_at, stopped_at`

type SessionStore struct{ db *sqlx.DB }

func NewSessionStore(db *sqlx.DB) *SessionStore { return &SessionStore{db} }

func (s *SessionStore) Create(ctx context.Context, sess *model.Session) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO sessions (session_id, agent_id, status)
		VALUES ($1,$2,$3)
		RETURNING created_at`,
		sess.SessionID, sess.AgentID, sess.Status,
	).Scan(&sess.CreatedAt)
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

func (s *SessionStore) ListByAgent(ctx context.Context, agentID uuid.UUID) ([]*model.Session, error) {
	var sessions []*model.Session
	err := s.db.SelectContext(ctx, &sessions,
		`SELECT `+sessionColumns+` FROM sessions WHERE agent_id=$1 ORDER BY created_at DESC`, agentID,
	)
	return sessions, err
}

func (s *SessionStore) UpdateReady(ctx context.Context, id uuid.UUID, harnessSessionID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET status='ready', harness_session_id=$1 WHERE session_id=$2`,
		harnessSessionID, id,
	)
	return err
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

func (s *SessionStore) MarkStopped(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET status='dead', stopped_at=NOW() WHERE session_id=$1`, id,
	)
	return err
}
