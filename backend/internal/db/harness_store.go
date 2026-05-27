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

const harnessColumns = `harness_id, project_id, harness_name, model, type, env_vars, sandbox_status, task_name, sandbox_url, created_at`

type HarnessStore struct{ db *sqlx.DB }

func NewHarnessStore(db *sqlx.DB) *HarnessStore { return &HarnessStore{db} }

func (s *HarnessStore) Create(ctx context.Context, h *model.Harness) error {
	env, _ := json.Marshal(h.EnvVars)
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO harnesses (harness_id, project_id, harness_name, model, type, env_vars)
		VALUES ($1,$2,$3,$4,$5,$6)
		RETURNING created_at, sandbox_status`,
		h.HarnessID, h.ProjectID, h.HarnessName, h.Model, h.Type, env,
	).Scan(&h.CreatedAt, &h.SandboxStatus)
}

// GetByID is the internal lookup — no access check. Used by sandbox manager
// and other server-driven paths. User-facing handlers must use GetAccessible
// or project-scoped resolvers instead.
func (s *HarnessStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Harness, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+harnessColumns+` FROM harnesses WHERE harness_id=$1`, id)
	return scanHarness(row)
}

func (s *HarnessStore) GetForProject(ctx context.Context, id, projectID uuid.UUID) (*model.Harness, error) {
	row := s.db.QueryRowxContext(ctx,
		`SELECT `+harnessColumns+` FROM harnesses WHERE harness_id=$1 AND project_id=$2`,
		id, projectID,
	)
	return scanHarness(row)
}

func (s *HarnessStore) GetAccessible(ctx context.Context, id, userID uuid.UUID) (*model.HarnessAccess, error) {
	row := s.db.QueryRowxContext(ctx, `
		SELECT `+prefixedHarnessColumns("h")+`,
		       CASE WHEN p.owner_user_id=$2 THEN $3 ELSE ps.role END AS access_role,
		       u.username AS owner_username,
		       `+prefixedProjectColumns("p")+`
		FROM harnesses h
		JOIN projects p ON p.project_id = h.project_id
		JOIN users u ON u.user_id = p.owner_user_id
		LEFT JOIN project_members ps ON ps.project_id = p.project_id AND ps.user_id = $2
		WHERE h.harness_id=$1 AND (p.owner_user_id=$2 OR ps.user_id IS NOT NULL)`,
		id, userID, model.AccessOwner,
	)
	return scanHarnessAccess(row)
}

func (s *HarnessStore) ListByProject(ctx context.Context, projectID uuid.UUID) ([]*model.Harness, error) {
	rows, err := s.db.QueryxContext(ctx,
		`SELECT `+harnessColumns+` FROM harnesses WHERE project_id=$1 ORDER BY created_at DESC`,
		projectID,
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

func (s *HarnessStore) ListForOwner(ctx context.Context, ownerID uuid.UUID) ([]*model.Harness, error) {
	rows, err := s.db.QueryxContext(ctx, `
		SELECT `+prefixedHarnessColumns("h")+`
		FROM harnesses h
		JOIN projects p ON p.project_id = h.project_id
		WHERE p.owner_user_id=$1
		ORDER BY h.created_at DESC`,
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

func (s *HarnessStore) UpdateNameForProject(ctx context.Context, id, projectID uuid.UUID, name string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE harnesses SET harness_name=$1 WHERE harness_id=$2 AND project_id=$3`,
		name, id, projectID,
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

func (s *HarnessStore) DeleteForProject(ctx context.Context, id, projectID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM harnesses WHERE harness_id=$1 AND project_id=$2`,
		id, projectID,
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

func prefixedHarnessColumns(alias string) string {
	cols := []string{
		"harness_id", "project_id", "harness_name", "model", "type",
		"env_vars", "sandbox_status", "task_name", "sandbox_url", "created_at",
	}
	out := ""
	for i, col := range cols {
		if i > 0 {
			out += ", "
		}
		out += alias + "." + col
	}
	return out
}

func scanHarness(row scanner) (*model.Harness, error) {
	var h model.Harness
	var envRaw []byte
	err := row.Scan(
		&h.HarnessID, &h.ProjectID, &h.HarnessName, &h.Model, &h.Type,
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

func scanHarnessAccess(row scanner) (*model.HarnessAccess, error) {
	var h model.Harness
	var envRaw []byte
	var role string
	var ownerUsername string
	var p model.Project
	err := row.Scan(
		&h.HarnessID, &h.ProjectID, &h.HarnessName, &h.Model, &h.Type,
		&envRaw,
		&h.SandboxStatus, &h.TaskName, &h.SandboxURL, &h.CreatedAt,
		&role, &ownerUsername,
		&p.ProjectID, &p.OwnerUserID, &p.ProjectName, &p.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrHarnessNotFound
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(envRaw, &h.EnvVars)
	return &model.HarnessAccess{Harness: &h, AccessRole: role, OwnerUsername: ownerUsername, Project: &p}, nil
}
