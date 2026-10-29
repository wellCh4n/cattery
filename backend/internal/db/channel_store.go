package db

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/wellch4n/cattery/internal/model"
)

const channelColumns = `channel_id, project_id, type, name, model, effort, config, enabled, status, last_error, created_by_user_id, created_at,
	COALESCE((SELECT username FROM users WHERE user_id=channels.created_by_user_id), '') AS created_by_username,
	COALESCE((SELECT name FROM users WHERE user_id=channels.created_by_user_id), '') AS created_by_name,
	COALESCE((SELECT version FROM user_avatars WHERE user_id=channels.created_by_user_id), '') AS created_by_avatar_version`

// ChannelStore keeps chat channels. A channel's config is written key by key
// (MergeConfig, SetState), so the plugin saving its state never overwrites an
// edit of its settings, nor the other way round.
type ChannelStore struct{ db *sqlx.DB }

func NewChannelStore(db *sqlx.DB) *ChannelStore { return &ChannelStore{db} }

func (s *ChannelStore) Create(ctx context.Context, ch *model.Channel) error {
	return s.db.QueryRowxContext(ctx, `
		INSERT INTO channels (channel_id, project_id, type, name, model, effort, config, enabled, status, created_by_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING `+channelColumns,
		ch.ChannelID, ch.ProjectID, ch.Type, ch.Name, ch.Model, ch.Effort, ch.Config, ch.Enabled, ch.Status, ch.CreatedByUserID,
	).StructScan(ch)
}

func (s *ChannelStore) Get(ctx context.Context, id uuid.UUID) (*model.Channel, error) {
	var ch model.Channel
	err := s.db.GetContext(ctx, &ch, `SELECT `+channelColumns+` FROM channels WHERE channel_id=$1`, id)
	return &ch, err
}

func (s *ChannelStore) ListByProject(ctx context.Context, projectID uuid.UUID) ([]*model.Channel, error) {
	channels := []*model.Channel{}
	err := s.db.SelectContext(ctx, &channels, `SELECT `+channelColumns+` FROM channels WHERE project_id=$1 ORDER BY created_at DESC, channel_id ASC`, projectID)
	return channels, err
}

// ListEnabled is every channel that should be connected.
func (s *ChannelStore) ListEnabled(ctx context.Context) ([]*model.Channel, error) {
	channels := []*model.Channel{}
	err := s.db.SelectContext(ctx, &channels, `SELECT `+channelColumns+` FROM channels WHERE enabled ORDER BY created_at`)
	return channels, err
}

// Update sets the fields its owner edits.
func (s *ChannelStore) Update(ctx context.Context, id uuid.UUID, name, modelID, effort string, enabled bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE channels SET name=$2, model=$3, effort=$4, enabled=$5 WHERE channel_id=$1`, id, name, modelID, effort, enabled)
	return err
}

// MergeConfig replaces the top-level config keys in patch, leaving the rest.
func (s *ChannelStore) MergeConfig(ctx context.Context, id uuid.UUID, patch map[string]any) error {
	b, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE channels SET config = config || $2::jsonb WHERE channel_id=$1`, id, b)
	return err
}

// SetState saves the plugin's state; only the plugin's own goroutine calls it.
func (s *ChannelStore) SetState(ctx context.Context, id uuid.UUID, state json.RawMessage) error {
	_, err := s.db.ExecContext(ctx, `UPDATE channels SET config = config || jsonb_build_object('state', $2::jsonb) WHERE channel_id=$1`, id, []byte(state))
	return err
}

// SetStatus records the connection's health. It reports whether it changed.
func (s *ChannelStore) SetStatus(ctx context.Context, id uuid.UUID, status string, lastError *string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE channels SET status=$2, last_error=$3
		WHERE channel_id=$1 AND (status IS DISTINCT FROM $2 OR last_error IS DISTINCT FROM $3)`, id, status, lastError)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

func (s *ChannelStore) Delete(ctx context.Context, id uuid.UUID) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM channels WHERE channel_id=$1`, id)
	return err
}
