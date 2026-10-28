-- 040_departments.sql
-- Adds a first-class "department" concept on top of the org chart.
--
-- Departments are orthogonal to roles and org hierarchy:
--   * Role      = what you can DO (permissions + scope_to_pic flag)
--   * Manager   = who you report to (drives project ACL for scoped roles)
--   * Department = which team you BELONG TO (org grouping + UI tinting)
--
-- We don't use department for access control — scoping still flows
-- through manager_id. Department is for visibility: colour-code the
-- org chart, filter the members list, label users on project pages.

CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  -- 6-char hex (without "#"). Rendered as a stripe on the org card
  -- and a chip on the member row. Stored as text so we can pick any
  -- colour, not just a predefined palette.
  color       TEXT NOT NULL DEFAULT '64748b',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);
