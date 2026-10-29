package db

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

// UsageRow is token usage summed per period, user and model.
type UsageRow struct {
	Period        string     `db:"period"      json:"period"`
	UserID        *uuid.UUID `db:"user_id"     json:"user_id"`
	Username      *string    `db:"username"    json:"username"`
	Name          string     `db:"name" json:"name"`
	AvatarVersion string     `db:"avatar_version" json:"avatar_version"`
	Model         string     `db:"model"       json:"model"`
	Requests      int64      `db:"requests"    json:"requests"`
	Input         int64      `db:"input"       json:"input"`
	Output        int64      `db:"output"      json:"output"`
	CacheRead     int64      `db:"cache_read"  json:"cache_read"`
	CacheWrite    int64      `db:"cache_write" json:"cache_write"`
}

var ErrUnknownTimeZone = errors.New("unknown time zone")

type UsageStore struct{ db *sqlx.DB }

func NewUsageStore(db *sqlx.DB) *UsageStore { return &UsageStore{db} }

// ReadyProjects lists projects whose agent sandbox is up.
func (s *UsageStore) ReadyProjects(ctx context.Context) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	err := s.db.SelectContext(ctx, &ids, `SELECT project_id FROM projects WHERE sandbox_status='ready'`)
	return ids, err
}

func (s *UsageStore) Offset(ctx context.Context, projectID uuid.UUID) (int64, error) {
	var offset int64
	err := s.db.GetContext(ctx, &offset, `SELECT usage_offset FROM projects WHERE project_id=$1`, projectID)
	return offset, err
}

// Ingest stores records and advances the project's ledger offset together.
// Records seen before are skipped. Each is charged to its session's creator,
// falling back to the project owner for sessions without one; a channel's
// records (their session id is the channel id) go to the channel's creator.
// Records of conversations already deleted keep no user.
func (s *UsageStore) Ingest(ctx context.Context, projectID uuid.UUID, records []model.UsageRecord, offset int64) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, r := range records {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO usage_records (record_id, project_id, session_id, user_id, username, kind, model, input, output, cache_read, cache_write, created_at)
			SELECT $1, $2, $3, u.user_id, u.username, $4, $5, $6, $7, $8, $9, to_timestamp($10::double precision / 1000)
			FROM (SELECT 1) one
			LEFT JOIN sessions s ON s.session_id = $3
			LEFT JOIN channels ch ON ch.channel_id = $3
			LEFT JOIN projects p ON p.project_id = COALESCE(s.project_id, ch.project_id)
			LEFT JOIN users u ON u.user_id = COALESCE(s.created_by_user_id, ch.created_by_user_id, p.owner_user_id)
			ON CONFLICT (record_id) DO NOTHING`,
			r.ID, projectID, r.SessionID, r.Kind, r.Model, r.Input, r.Output, r.CacheRead, r.CacheWrite, r.At,
		); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE projects SET usage_offset=$2 WHERE project_id=$1`, projectID, offset); err != nil {
		return err
	}
	return tx.Commit()
}

// Stats sums usage in [from, to) per bucket ("day", "week" or "month", weeks
// starting Monday) in the time zone tz, for one user or, with a nil userID,
// everyone. Periods are the bucket's first day, YYYY-MM-DD.
func (s *UsageStore) Stats(ctx context.Context, from, to time.Time, bucket, tz string, userID *uuid.UUID) ([]UsageRow, error) {
	var known bool
	if err := s.db.GetContext(ctx, &known, `SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=$1)`, tz); err != nil {
		return nil, err
	}
	if !known {
		return nil, ErrUnknownTimeZone
	}
	rows := []UsageRow{}
	err := s.db.SelectContext(ctx, &rows, `
		SELECT to_char(date_trunc($1, created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS period,
		       user_id, MAX(username) AS username, model,
		       COUNT(*) AS requests, SUM(input) AS input, SUM(output) AS output,
		       SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write,
               COALESCE((SELECT name FROM users WHERE users.user_id=usage_records.user_id), '') AS name,
               COALESCE((SELECT version FROM user_avatars WHERE user_avatars.user_id=usage_records.user_id), '') AS avatar_version
		FROM usage_records
		WHERE created_at >= ($3::date)::timestamp AT TIME ZONE $2
		  AND created_at <  ($4::date)::timestamp AT TIME ZONE $2
		  AND ($5::uuid IS NULL OR user_id = $5)
		GROUP BY 1, user_id, CASE WHEN user_id IS NULL THEN username END, model
		ORDER BY 1, 3, 4`,
		bucket, tz, from.Format(time.DateOnly), to.Format(time.DateOnly), userID,
	)
	return rows, err
}
