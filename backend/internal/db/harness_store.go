package db

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const harnessColumns = `harness_id, harness_name, model, type, env_vars, sandbox_status, task_name, sandbox_url, created_at`

type HarnessStore struct{ db *sqlx.DB }

func NewHarnessStore(db *sqlx.DB) *HarnessStore { return &HarnessStore{db} }

func (s *HarnessStore) Create(ctx context.Context, h *model.Harness) error {
	env, _ := json.Marshal(h.EnvVars)
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO harnesses (harness_id, harness_name, model, type, env_vars)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING created_at, sandbox_status`,
		h.HarnessID, h.HarnessName, h.Model, h.Type, env,
	).Scan(&h.CreatedAt, &h.SandboxStatus)
}

func (s *HarnessStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Harness, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+harnessColumns+` FROM harnesses WHERE harness_id=$1`, id)
	return scanHarness(row)
}

func (s *HarnessStore) List(ctx context.Context) ([]*model.Harness, error) {
	rows, err := s.db.QueryxContext(ctx, `SELECT `+harnessColumns+` FROM harnesses ORDER BY created_at DESC`)
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

func (s *HarnessStore) UpdateName(ctx context.Context, id uuid.UUID, name string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET harness_name=$1 WHERE harness_id=$2`, name, id,
	)
	return err
}

func (s *HarnessStore) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM harnesses WHERE harness_id=$1`, id)
	return err
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
	if err := row.Scan(
		&h.HarnessID, &h.HarnessName, &h.Model, &h.Type,
		&envRaw,
		&h.SandboxStatus, &h.TaskName, &h.SandboxURL, &h.CreatedAt,
	); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(envRaw, &h.EnvVars)
	return &h, nil
}
