package db

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

var ErrProjectNotFound = errors.New("project not found")

const projectColumns = `project_id, owner_user_id, project_name, created_at`

type ProjectStore struct{ db *sqlx.DB }

func NewProjectStore(db *sqlx.DB) *ProjectStore { return &ProjectStore{db} }

func (s *ProjectStore) Create(ctx context.Context, p *model.Project) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO projects (project_id, owner_user_id, project_name)
		VALUES ($1,$2,$3)
		RETURNING created_at`,
		p.ProjectID, p.OwnerUserID, p.ProjectName,
	).Scan(&p.CreatedAt)
}

func (s *ProjectStore) GetByID(ctx context.Context, id uuid.UUID) (*model.Project, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+projectColumns+` FROM projects WHERE project_id=$1`, id)
	return scanProject(row)
}

func (s *ProjectStore) GetAccessible(ctx context.Context, id, userID uuid.UUID) (*model.ProjectAccess, error) {
	row := s.db.QueryRowxContext(ctx, `
		SELECT `+prefixedProjectColumns("p")+`,
		       CASE WHEN p.owner_user_id=$2 THEN $3 ELSE ps.role END AS access_role,
		       u.username AS owner_username
		FROM projects p
		JOIN users u ON u.user_id = p.owner_user_id
		LEFT JOIN project_members ps ON ps.project_id = p.project_id AND ps.user_id = $2
		WHERE p.project_id=$1 AND (p.owner_user_id=$2 OR ps.user_id IS NOT NULL)`,
		id, userID, model.AccessOwner,
	)
	return scanProjectAccess(row)
}

func (s *ProjectStore) ListAccessible(ctx context.Context, userID uuid.UUID) ([]*model.ProjectAccess, error) {
	rows, err := s.db.QueryxContext(ctx, `
		SELECT `+prefixedProjectColumns("p")+`,
		       CASE WHEN p.owner_user_id=$1 THEN $2 ELSE ps.role END AS access_role,
		       u.username AS owner_username
		FROM projects p
		JOIN users u ON u.user_id = p.owner_user_id
		LEFT JOIN project_members ps ON ps.project_id = p.project_id AND ps.user_id = $1
		WHERE p.owner_user_id=$1 OR ps.user_id IS NOT NULL
		ORDER BY
			CASE WHEN p.owner_user_id=$1 THEN 0 ELSE 1 END,
			p.created_at DESC`,
		userID, model.AccessOwner,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.ProjectAccess
	for rows.Next() {
		access, err := scanProjectAccess(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, access)
	}
	return out, nil
}

func (s *ProjectStore) ListForOwner(ctx context.Context, ownerID uuid.UUID) ([]*model.Project, error) {
	rows, err := s.db.QueryxContext(ctx,
		`SELECT `+projectColumns+` FROM projects WHERE owner_user_id=$1 ORDER BY created_at DESC`,
		ownerID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var projects []*model.Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, nil
}

func (s *ProjectStore) UpdateNameForOwner(ctx context.Context, id, ownerID uuid.UUID, name string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE projects SET project_name=$1 WHERE project_id=$2 AND owner_user_id=$3`,
		name, id, ownerID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrProjectNotFound
	}
	return nil
}

func (s *ProjectStore) DeleteForOwner(ctx context.Context, id, ownerID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM projects WHERE project_id=$1 AND owner_user_id=$2`,
		id, ownerID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrProjectNotFound
	}
	return nil
}

func prefixedProjectColumns(alias string) string {
	cols := []string{"project_id", "owner_user_id", "project_name", "created_at"}
	out := ""
	for i, col := range cols {
		if i > 0 {
			out += ", "
		}
		out += alias + "." + col
	}
	return out
}

func scanProject(row scanner) (*model.Project, error) {
	var p model.Project
	err := row.Scan(&p.ProjectID, &p.OwnerUserID, &p.ProjectName, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func scanProjectAccess(row scanner) (*model.ProjectAccess, error) {
	var p model.Project
	var role string
	var ownerUsername string
	err := row.Scan(&p.ProjectID, &p.OwnerUserID, &p.ProjectName, &p.CreatedAt, &role, &ownerUsername)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrProjectNotFound
	}
	if err != nil {
		return nil, err
	}
	return &model.ProjectAccess{Project: &p, AccessRole: role, OwnerUsername: ownerUsername}, nil
}
