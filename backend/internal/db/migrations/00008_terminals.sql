-- +goose Up
CREATE TABLE terminals (
    terminal_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Terminal',
    created_by_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_by_username TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Retain deleted IDs so a stale browser import cannot resurrect a terminal.
    deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_terminals_project ON terminals(project_id, created_at DESC);
CREATE INDEX idx_terminals_creator ON terminals(created_by_user_id);

-- +goose Down
DROP TABLE terminals;
