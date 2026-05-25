package db

import (
	"context"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const sessionColumns = `session_id, harness_id, status, phase, title, harness_session_id, created_at, last_seen_at, stopped_at`

type SessionStore struct{ db *sqlx.DB }

func NewSessionStore(db *sqlx.DB) *SessionStore { return &SessionStore{db} }

func (s *SessionStore) Create(ctx context.Context, sess *model.Session) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO sessions (session_id, harness_id, status)
		VALUES ($1,$2,$3)
		RETURNING created_at`,
		sess.SessionID, sess.HarnessID, sess.Status,
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

func (s *SessionStore) ListByHarness(ctx context.Context, harnessID uuid.UUID) ([]*model.Session, error) {
	var sessions []*model.Session
	err := s.db.SelectContext(ctx, &sessions,
		`SELECT `+sessionColumns+` FROM sessions WHERE harness_id=$1 AND status != 'dead' ORDER BY created_at DESC`, harnessID,
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

func (s *SessionStore) UpdateTitle(ctx context.Context, id uuid.UUID, title string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET title=$1 WHERE session_id=$2`, title, id,
	)
	return err
}

func (s *SessionStore) MarkStopped(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET status='dead', stopped_at=NOW() WHERE session_id=$1`, id,
	)
	return err
}

// HardDelete removes the row entirely. Caller is responsible for first aborting
// the harness-side session so we don't leave it running.
func (s *SessionStore) HardDelete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE session_id=$1`, id)
	return err
}

// PurgeDeadByHarness removes all dead sessions under a single harness and
// returns the number of rows deleted. Used by the per-harness "clean up" UI.
func (s *SessionStore) PurgeDeadByHarness(ctx context.Context, harnessID uuid.UUID) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM sessions WHERE harness_id=$1 AND status='dead'`, harnessID,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// PurgeDeadByOwner removes every dead session that belongs (transitively) to a
// user's owned harnesses. Sessions inside *shared* harnesses are left alone —
// that's the harness owner's call to make, not the share recipient's.
func (s *SessionStore) PurgeDeadByOwner(ctx context.Context, ownerUserID uuid.UUID) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM sessions
		WHERE status='dead'
		  AND harness_id IN (SELECT harness_id FROM harnesses WHERE owner_user_id=$1)
	`, ownerUserID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
