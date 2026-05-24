package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

var ErrHarnessNotFound = errors.New("harness not found")

const harnessColumns = `harness_id, owner_user_id, harness_name, model, type, env_vars, sandbox_status, task_name, sandbox_url, created_at`

type HarnessStore struct{ db *sqlx.DB }

func NewHarnessStore(db *sqlx.DB) *HarnessStore { return &HarnessStore{db} }

func (s *HarnessStore) Create(ctx context.Context, h *model.Harness) error {
	env, _ := json.Marshal(h.EnvVars)
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO harnesses (harness_id, owner_user_id, harness_name, model, type, env_vars)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING created_at, sandbox_status`,
		h.HarnessID, h.OwnerUserID, h.HarnessName, h.Model, h.Type, env,
	).Scan(&h.CreatedAt, &h.SandboxStatus)
}

// GetByID is the internal lookup — no owner check. Used by sandbox manager
// and any other server-driven path. User-facing handlers must use GetForOwner
// instead, otherwise one user could touch another user's harness by ID.
func (s *HarnessStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Harness, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+harnessColumns+` FROM harnesses WHERE harness_id=$1`, id)
	return scanHarness(row)
}

// GetForOwner returns the harness only if it belongs to ownerID. Missing
// rows and owner mismatches both surface as ErrHarnessNotFound so callers
// can return 404 without revealing existence.
func (s *HarnessStore) GetForOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.Harness, error) {
	row := s.db.QueryRowxContext(ctx,
		`SELECT `+harnessColumns+` FROM harnesses WHERE harness_id=$1 AND owner_user_id=$2`,
		id, ownerID,
	)
	return scanHarness(row)
}

func (s *HarnessStore) ListForOwner(ctx context.Context, ownerID uuid.UUID) ([]*model.Harness, error) {
	rows, err := s.db.QueryxContext(ctx,
		`SELECT `+harnessColumns+` FROM harnesses WHERE owner_user_id=$1 ORDER BY created_at DESC`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var harnesses []*model.Harness
	for rows.Next() {
		h, err := scanHarness(rows)
		if err != nil {
			return nil, err
		}
		harnesses = append(harnesses, h)
	}
	return harnesses, nil
}

// UpdateNameForOwner returns ErrHarnessNotFound if no row matches both
// harness_id and owner_user_id — keeps the 404-on-cross-tenant semantics.
func (s *HarnessStore) UpdateNameForOwner(ctx context.Context, id, ownerID uuid.UUID, name string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET harness_name=$1 WHERE harness_id=$2 AND owner_user_id=$3`,
		name, id, ownerID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrHarnessNotFound
	}
	return nil
}

func (s *HarnessStore) DeleteForOwner(ctx context.Context, id, ownerID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM harnesses WHERE harness_id=$1 AND owner_user_id=$2`,
		id, ownerID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrHarnessNotFound
	}
	return nil
}

func (s *HarnessStore) UpdateSandboxStarting(ctx context.Context, id uuid.UUID, taskName string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET sandbox_status='starting', task_name=$1 WHERE harness_id=$2`,
		taskName, id,
	)
	return err
}

func (s *HarnessStore) UpdateSandboxReady(ctx context.Context, id uuid.UUID, sandboxURL string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET sandbox_status='ready', sandbox_url=$1 WHERE harness_id=$2`,
		sandboxURL, id,
	)
	return err
}

func (s *HarnessStore) UpdateSandboxStatus(ctx context.Context, id uuid.UUID, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET sandbox_status=$1 WHERE harness_id=$2`,
		status, id,
	)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanHarness(row scanner) (*model.Harness, error) {
	var h model.Harness
	var envRaw []byte
	err := row.Scan(
		&h.HarnessID, &h.OwnerUserID, &h.HarnessName, &h.Model, &h.Type,
		&envRaw,
		&h.SandboxStatus, &h.TaskName, &h.SandboxURL, &h.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrHarnessNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(envRaw, &h.EnvVars)
	return &h, nil
}
