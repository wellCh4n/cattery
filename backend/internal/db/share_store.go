package db

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

var ErrShareNotFound = errors.New("harness share not found")

const shareColumns = `s.harness_id, s.user_id, u.username, s.role, s.created_at`

type ShareStore struct{ db *sqlx.DB }

func NewShareStore(db *sqlx.DB) *ShareStore { return &ShareStore{db} }

func (s *ShareStore) ListByHarness(ctx context.Context, harnessID uuid.UUID) ([]*model.HarnessShare, error) {
	rows, err := s.db.QueryxContext(ctx, `
		SELECT `+shareColumns+`
		FROM harness_shares s
		JOIN users u ON u.user_id = s.user_id
		WHERE s.harness_id=$1
		ORDER BY u.username ASC`,
		harnessID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.HarnessShare
	for rows.Next() {
		share, err := scanShare(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, share)
	}
	return out, nil
}

func (s *ShareStore) Upsert(ctx context.Context, harnessID, userID uuid.UUID, role string) (*model.HarnessShare, error) {
	row := s.db.QueryRowxContext(ctx, `
		INSERT INTO harness_shares (harness_id, user_id, role)
		VALUES ($1,$2,$3)
		ON CONFLICT (harness_id, user_id)
		DO UPDATE SET role=EXCLUDED.role
		RETURNING harness_id, user_id, role, created_at`,
		harnessID, userID, role,
	)
	var share model.HarnessShare
	if err := row.Scan(&share.HarnessID, &share.UserID, &share.Role, &share.CreatedAt); err != nil {
		return nil, err
	}
	var username string
	if err := s.db.GetContext(ctx, &username, `SELECT username FROM users WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	share.Username = username
	return &share, nil
}

func (s *ShareStore) UpdateRole(ctx context.Context, harnessID, userID uuid.UUID, role string) (*model.HarnessShare, error) {
	row := s.db.QueryRowxContext(ctx, `
		UPDATE harness_shares SET role=$1
		WHERE harness_id=$2 AND user_id=$3
		RETURNING harness_id, user_id, role, created_at`,
		role, harnessID, userID,
	)
	var share model.HarnessShare
	if err := row.Scan(&share.HarnessID, &share.UserID, &share.Role, &share.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrShareNotFound
		}
		return nil, err
	}
	var username string
	if err := s.db.GetContext(ctx, &username, `SELECT username FROM users WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	share.Username = username
	return &share, nil
}

func (s *ShareStore) Delete(ctx context.Context, harnessID, userID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM harness_shares WHERE harness_id=$1 AND user_id=$2`,
		harnessID, userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrShareNotFound
	}
	return nil
}

func scanShare(row scanner) (*model.HarnessShare, error) {
	var share model.HarnessShare
	err := row.Scan(&share.HarnessID, &share.UserID, &share.Username, &share.Role, &share.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrShareNotFound
	}
	if err != nil {
		return nil, err
	}
	return &share, nil
}
