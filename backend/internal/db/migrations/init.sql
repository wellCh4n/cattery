CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE agents (
    agent_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name      TEXT,
    model           TEXT        NOT NULL,
    prompt          TEXT,
    harness_id      TEXT        NOT NULL DEFAULT 'opencode',
    repo_url        TEXT,
    branch          TEXT        NOT NULL DEFAULT 'main',
    env_vars        JSONB       NOT NULL DEFAULT '{}',
    container_port  INT         NOT NULL DEFAULT 4096,
    sandbox_status  TEXT        NOT NULL DEFAULT 'idle',
    task_name       TEXT,
    sandbox_url     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
    session_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id            UUID        NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    status              TEXT        NOT NULL DEFAULT 'creating',
    phase               TEXT,
    harness_session_id  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at        TIMESTAMPTZ,
    stopped_at          TIMESTAMPTZ
);

CREATE INDEX idx_sessions_agent_id ON sessions(agent_id);
CREATE INDEX idx_sessions_status   ON sessions(status);
