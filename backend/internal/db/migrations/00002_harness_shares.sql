-- +goose Up
CREATE TABLE IF NOT EXISTS harness_shares (
    harness_id UUID        NOT NULL REFERENCES harnesses(harness_id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (harness_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_harness_shares_user ON harness_shares(user_id);

-- +goose Down
DROP TABLE IF EXISTS harness_shares;
