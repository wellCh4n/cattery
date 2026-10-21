-- +goose Up
ALTER TABLE sessions ADD COLUMN title_manual BOOLEAN NOT NULL DEFAULT FALSE;
-- Existing names have unknown provenance; preserve them conservatively.
UPDATE sessions SET title_manual = TRUE WHERE title IS NOT NULL AND title <> '';

-- +goose Down
ALTER TABLE sessions DROP COLUMN title_manual;
