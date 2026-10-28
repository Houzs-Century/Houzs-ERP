-- 048_department_brands.sql
-- Brand-scoped sales departments. Each row says "department X is
-- responsible for brand Y". Many-to-many. Sales Director / Sales
-- Person who scope_to_pic see only projects whose brand is in their
-- department's brand allow-list (intersected with the existing PIC
-- one-hop rule).
--
-- Brand stored as TEXT to match the soft-FK pattern between
-- projects.brand and project_brands.name (migration 044). Validation
-- happens in the route layer against project_brands so an archived
-- brand still scopes existing projects but disappears from new
-- pickers.
--
-- Idempotent. Existing departments start with an empty brand list,
-- which (per the AND-clause in projectAcl) makes their scoped users
-- invisible to all projects until an admin assigns brands.

CREATE TABLE IF NOT EXISTS department_brands (
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  brand         TEXT    NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (department_id, brand)
);

CREATE INDEX IF NOT EXISTS idx_dept_brands_brand ON department_brands(brand);
