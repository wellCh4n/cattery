-- +goose Up
-- Historical sessions have no reliable creator information. Keep them unknown.
ALTER TABLE sessions
    ADD COLUMN created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    ADD COLUMN created_by_username TEXT;
-- The username is a creation-time snapshot, retained if the account is deleted.
CREATE INDEX idx_sessions_created_by_user_id ON sessions(created_by_user_id);

-- +goose Down
ALTER TABLE sessions
    DROP COLUMN created_by_user_id,
    DROP COLUMN created_by_username;
