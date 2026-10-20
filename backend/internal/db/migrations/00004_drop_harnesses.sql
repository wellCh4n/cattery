-- +goose Up
-- Cattery now runs a single agent (pi), so the Harness layer is gone:
-- Project → Session. Each project owns one agent sandbox (status lives on the
-- project) and each session picks its own model. Existing harnesses and their
-- sessions belonged to the removed harness images and can't be replayed by
-- pi, so they are dropped rather than migrated. Their K8s Sandbox CRs are not
-- touched by this migration; delete leftovers with
--   kubectl delete sandboxes -l app.kubernetes.io/component=sandbox
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS harnesses;

ALTER TABLE projects ADD COLUMN sandbox_status TEXT NOT NULL DEFAULT 'idle';

CREATE TABLE sessions (
    session_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id    UUID        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    model         TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'creating',
    phase         TEXT,
    title         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ
);
CREATE INDEX idx_sessions_project_id ON sessions(project_id);

-- +goose Down
DROP TABLE IF EXISTS sessions;
ALTER TABLE projects DROP COLUMN IF EXISTS sandbox_status;

CREATE TABLE harnesses (
    harness_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID        NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    harness_name    TEXT,
    model           TEXT        NOT NULL,
    type            TEXT        NOT NULL DEFAULT 'opencode',
    env_vars        JSONB       NOT NULL DEFAULT '{}',
    sandbox_status  TEXT        NOT NULL DEFAULT 'idle',
    task_name       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_harnesses_project ON harnesses(project_id);

CREATE TABLE sessions (
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
CREATE INDEX idx_sessions_harness_id ON sessions(harness_id);
CREATE INDEX idx_sessions_status     ON sessions(status);
