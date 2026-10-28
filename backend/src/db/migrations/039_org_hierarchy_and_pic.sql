-- 039_org_hierarchy_and_pic.sql
-- Adds:
--   * users.manager_id — who this user reports to (self-ref FK)
--   * projects.pic_id — person-in-charge (sales lead) for the project
--   * roles.scope_to_pic — when 1, users with this role see only projects
--     where pic_id = user.id OR pic_id = user.manager_id. Default 0 so
--     existing roles keep full access until explicitly scoped.

ALTER TABLE users ADD COLUMN manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_manager ON users(manager_id);

ALTER TABLE projects ADD COLUMN pic_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_pic ON projects(pic_id);

ALTER TABLE roles ADD COLUMN scope_to_pic INTEGER NOT NULL DEFAULT 0;
