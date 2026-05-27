-- +goose Up
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username      TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    is_admin      BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS projects (
    project_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_user_id  UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    project_name   TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id);

CREATE TABLE IF NOT EXISTS harnesses (
    harness_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    harness_name    TEXT,
    model           TEXT        NOT NULL,
    type            TEXT        NOT NULL DEFAULT 'opencode',
    env_vars        JSONB       NOT NULL DEFAULT '{}',
    sandbox_status  TEXT        NOT NULL DEFAULT 'idle',
    task_name       TEXT,
    sandbox_url     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_harnesses_project ON harnesses(project_id);

CREATE TABLE IF NOT EXISTS sessions (
    session_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    harness_id          UUID        NOT NULL REFERENCES harnesses(harness_id) ON DELETE CASCADE,
    status              TEXT        NOT NULL DEFAULT 'creating',
    phase               TEXT,
    title               TEXT,
    harness_session_id  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ,
    stopped_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_harness_id ON sessions(harness_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(status);

CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    role       TEXT        NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- +goose Down
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS harnesses;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS users;
DROP EXTENSION IF EXISTS "uuid-ossp";
