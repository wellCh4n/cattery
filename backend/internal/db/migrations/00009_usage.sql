-- +goose Up
-- One row per model request, pulled from each sandbox's usage ledger
-- (~/.cattery/usage.jsonl). Rows outlive their session and project, so neither
-- is a foreign key; the user is the session's creator at ingest time, with a
-- username snapshot that survives account deletion.
CREATE TABLE usage_records (
    record_id   TEXT PRIMARY KEY,
    project_id  UUID        NOT NULL,
    session_id  UUID        NOT NULL,
    user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
    username    TEXT,
    kind        TEXT        NOT NULL,
    model       TEXT        NOT NULL,
    input       BIGINT      NOT NULL DEFAULT 0,
    output      BIGINT      NOT NULL DEFAULT 0,
    cache_read  BIGINT      NOT NULL DEFAULT 0,
    cache_write BIGINT      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_usage_records_created_at ON usage_records(created_at);

-- Byte offset of the ledger already ingested.
ALTER TABLE projects ADD COLUMN usage_offset BIGINT NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE projects DROP COLUMN usage_offset;
DROP TABLE usage_records;
