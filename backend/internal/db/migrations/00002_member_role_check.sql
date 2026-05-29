-- +goose Up
-- Early baselines created project_members.role with CHECK (role IN
-- ('viewer','editor')). The model collapsed to a single 'member' role, but
-- goose never re-runs 00001 on databases that already applied it, so those
-- DBs kept the stale constraint and reject inserts of 'member'. Normalize any
-- legacy rows and swap the constraint to match the current model.
UPDATE project_members SET role = 'member' WHERE role <> 'member';
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check CHECK (role = 'member');

-- +goose Down
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_role_check;
ALTER TABLE project_members ADD CONSTRAINT project_members_role_check CHECK (role IN ('viewer', 'editor'));
