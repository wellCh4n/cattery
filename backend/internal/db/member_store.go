package db

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

var ErrMemberNotFound = errors.New("project member not found")

const memberColumns = `m.project_id, m.user_id, u.username, m.role, m.created_at`

type MemberStore struct{ db *sqlx.DB }

func NewMemberStore(db *sqlx.DB) *MemberStore { return &MemberStore{db} }

func (s *MemberStore) ListByProject(ctx context.Context, projectID uuid.UUID) ([]*model.ProjectMember, error) {
	rows, err := s.db.QueryxContext(ctx, `
		SELECT `+memberColumns+`
		FROM project_members m
		JOIN users u ON u.user_id = m.user_id
		WHERE m.project_id=$1
		ORDER BY u.username ASC`,
		projectID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.ProjectMember
	for rows.Next() {
		member, err := scanMember(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, member)
	}
	return out, nil
}

func (s *MemberStore) Upsert(ctx context.Context, projectID, userID uuid.UUID, role string) (*model.ProjectMember, error) {
	row := s.db.QueryRowxContext(ctx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1,$2,$3)
		ON CONFLICT (project_id, user_id)
		DO UPDATE SET role=EXCLUDED.role
		RETURNING project_id, user_id, role, created_at`,
		projectID, userID, role,
	)
	var member model.ProjectMember
	if err := row.Scan(&member.ProjectID, &member.UserID, &member.Role, &member.CreatedAt); err != nil {
		return nil, err
	}
	var username string
	if err := s.db.GetContext(ctx, &username, `SELECT username FROM users WHERE user_id=$1`, userID); err != nil {
		return nil, err
	}
	member.Username = username
	return &member, nil
}

func (s *MemberStore) Delete(ctx context.Context, projectID, userID uuid.UUID) error {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`,
		projectID, userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMemberNotFound
	}
	return nil
}

func scanMember(row scanner) (*model.ProjectMember, error) {
	var member model.ProjectMember
	err := row.Scan(&member.ProjectID, &member.UserID, &member.Username, &member.Role, &member.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrMemberNotFound
	}
	if err != nil {
		return nil, err
	}
	return &member, nil
}
