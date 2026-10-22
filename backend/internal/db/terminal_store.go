package db

import (
	"context"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const terminalColumns = `terminal_id, project_id, title, created_by_user_id, created_by_username, created_at`

type TerminalStore struct{ db *sqlx.DB }

func NewTerminalStore(db *sqlx.DB) *TerminalStore { return &TerminalStore{db} }

func (s *TerminalStore) Create(ctx context.Context, terminal *model.Terminal, creatorID uuid.UUID) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO terminals (terminal_id, project_id, created_by_user_id, created_by_username)
		SELECT $1, $2, user_id, username FROM users WHERE user_id=$3
		RETURNING title, created_at, created_by_user_id, created_by_username`,
		terminal.TerminalID, terminal.ProjectID, creatorID,
	).Scan(&terminal.Title, &terminal.CreatedAt, &terminal.CreatedByUserID, &terminal.CreatedByUsername)
}

func (s *TerminalStore) Get(ctx context.Context, projectID, terminalID uuid.UUID) (*model.Terminal, error) {
	var terminal model.Terminal
	err := s.db.GetContext(ctx, &terminal, `SELECT `+terminalColumns+` FROM terminals WHERE project_id=$1 AND terminal_id=$2 AND deleted_at IS NULL`, projectID, terminalID)
	return &terminal, err
}

func (s *TerminalStore) ListByProject(ctx context.Context, projectID uuid.UUID) ([]*model.Terminal, error) {
	terminals := []*model.Terminal{}
	err := s.db.SelectContext(ctx, &terminals, `SELECT `+terminalColumns+` FROM terminals WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC, terminal_id ASC`, projectID)
	return terminals, err
}

func (s *TerminalStore) Rename(ctx context.Context, projectID, terminalID uuid.UUID, title string) (*model.Terminal, error) {
	var terminal model.Terminal
	err := s.db.QueryRowxContext(ctx, `UPDATE terminals SET title=$3 WHERE project_id=$1 AND terminal_id=$2 AND deleted_at IS NULL RETURNING `+terminalColumns,
		projectID, terminalID, title).StructScan(&terminal)
	return &terminal, err
}

func (s *TerminalStore) Delete(ctx context.Context, projectID, terminalID uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE terminals SET deleted_at=NOW() WHERE project_id=$1 AND terminal_id=$2 AND deleted_at IS NULL`, projectID, terminalID)
	return err
}

// Import preserves legacy browser terminal IDs so existing tmux shells can be
// reattached. Their creator is unknown. Existing database records always win.
func (s *TerminalStore) Import(ctx context.Context, projectID uuid.UUID, terminals []model.Terminal) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, terminal := range terminals {
		if _, err := tx.ExecContext(ctx, `INSERT INTO terminals (terminal_id, project_id, title, created_at)
			VALUES ($1, $2, $3, $4) ON CONFLICT (terminal_id) DO NOTHING`,
			terminal.TerminalID, projectID, terminal.Title, terminal.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}
