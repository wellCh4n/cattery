-- +goose Up
-- Each session carries its own thinking effort, picked in the chat next to the
-- model. Empty means the model provider's default effort (see models.toml).
ALTER TABLE sessions ADD COLUMN effort TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN IF EXISTS effort;
