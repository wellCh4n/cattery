package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

var ErrUserNotFound = errors.New("user not found")

const userColumns = `user_id, username, password_hash, is_admin, created_at, last_login_at`

type UserStore struct{ db *sqlx.DB }

func NewUserStore(db *sqlx.DB) *UserStore { return &UserStore{db} }

func (s *UserStore) Create(ctx context.Context, u *model.User) error {
	u.Username = normalizeUsername(u.Username)
	return s.db.QueryRowxContext(ctx, `
        INSERT INTO users (username, password_hash, is_admin)
        VALUES ($1, $2, $3)
        RETURNING user_id, created_at`,
		u.Username, u.PasswordHash, u.IsAdmin,
	).Scan(&u.UserID, &u.CreatedAt)
}

func (s *UserStore) GetByID(ctx context.Context, id uuid.UUID) (*model.User, error) {
	row := s.db.QueryRowxContext(ctx, `SELECT `+userColumns+` FROM users WHERE user_id=$1`, id)
	return scanUser(row)
}

func (s *UserStore) GetByUsername(ctx context.Context, username string) (*model.User, error) {
	row := s.db.QueryRowxContext(ctx,
		`SELECT `+userColumns+` FROM users WHERE username=$1`,
		normalizeUsername(username),
	)
	return scanUser(row)
}

func (s *UserStore) List(ctx context.Context) ([]*model.User, error) {
	rows, err := s.db.QueryxContext(ctx, `SELECT `+userColumns+` FROM users ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*model.User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, nil
}

func (s *UserStore) UpdatePassword(ctx context.Context, id uuid.UUID, hash string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET password_hash=$1 WHERE user_id=$2`, hash, id)
	return err
}

func (s *UserStore) SetAdmin(ctx context.Context, id uuid.UUID, isAdmin bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET is_admin=$1 WHERE user_id=$2`, isAdmin, id)
	return err
}

// UpdatePasswordAndAdmin patches password_hash and/or is_admin in one
// statement. Nil arguments leave the column untouched via COALESCE; that
// way the admin endpoint can change either, both, or neither atomically
// without juggling an explicit transaction.
func (s *UserStore) UpdatePasswordAndAdmin(ctx context.Context, id uuid.UUID, passwordHash *string, isAdmin *bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET
            password_hash = COALESCE($1, password_hash),
            is_admin      = COALESCE($2, is_admin)
         WHERE user_id = $3`,
		passwordHash, isAdmin, id,
	)
	return err
}

func (s *UserStore) MarkLogin(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET last_login_at=NOW() WHERE user_id=$1`, id)
	return err
}

func (s *UserStore) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE user_id=$1`, id)
	return err
}

// CountAdmins is used by Delete/SetAdmin callers to keep at least one admin.
func (s *UserStore) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE is_admin=TRUE`).Scan(&n)
	return n, err
}

// Count returns the total number of users. Used by bootstrap to decide
// whether to seed the default admin account.
func (s *UserStore) Count(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// normalizeUsername lowercases + trims. Usernames are case-insensitive so
// "Admin" and "admin" can't both exist; the UNIQUE constraint stores the
// normalized form.
func normalizeUsername(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func scanUser(row scanner) (*model.User, error) {
	var u model.User
	err := row.Scan(&u.UserID, &u.Username, &u.PasswordHash, &u.IsAdmin, &u.CreatedAt, &u.LastLoginAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}
