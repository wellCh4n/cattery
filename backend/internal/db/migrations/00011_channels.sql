-- +goose Up
-- A chat channel: one Feishu or Lark bot, or one WeChat ClawBot login, bound to a
-- project. Each is one conversation, owned by whoever created it; its id is
-- also the agent's id for that conversation, whose transcript lives in
-- ~/.cattery/channels (never in sessions).
CREATE TABLE channels (
    channel_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('feishu', 'lark', 'weixin')),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    model TEXT NOT NULL,
    effort TEXT NOT NULL DEFAULT '',
    -- external_id, secret (sealed), owner_external_id, plugin settings and
    -- the plugin's state. Each writer replaces only its own top-level keys.
    config JSONB NOT NULL DEFAULT '{}',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'connecting',
    last_error TEXT,
    created_by_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_channels_project ON channels(project_id, created_at DESC);
-- One bot, one channel.
CREATE UNIQUE INDEX idx_channels_external ON channels(type, (config->>'external_id'));

-- +goose Down
DROP TABLE channels;
