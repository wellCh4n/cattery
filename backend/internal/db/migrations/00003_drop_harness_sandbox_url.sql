-- +goose Up
-- The harness sandbox URL is the pod's ephemeral IP. Persisting it meant a
-- rescheduled pod left a stale address in the DB that downstream calls kept
-- dialing. The backend now resolves the address live from K8s on each
-- connection, so the column is dead state — drop it. sandbox_status stays:
-- it still drives the UI badge and the start/reuse decision.
ALTER TABLE harnesses DROP COLUMN IF EXISTS sandbox_url;

-- +goose Down
ALTER TABLE harnesses ADD COLUMN sandbox_url TEXT;
