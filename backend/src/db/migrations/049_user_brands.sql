-- 049_user_brands.sql
-- Brand assignment moves from department to person.
--
-- Why: a single sales department often has directors covering
-- different brand subsets (e.g. one handles AKEMI, another ZANOTTI),
-- so attaching the allow-list to the dept created false coupling.
-- Per-user assignment lets each director have their own brand set;
-- their direct reports inherit the same set via the existing
-- manager_id one-hop.
--
-- Cleanup of mig 048: department_brands is dropped. Admins reassign
-- brands per user under Team → Members. No data migration — the dept
-- list was only live for one session and any rows are easily re-keyed.
--
-- Idempotent.

DROP TABLE IF EXISTS department_brands;

CREATE TABLE IF NOT EXISTS user_brands (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand      TEXT    NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, brand)
);

-- The PIC-validation EXISTS join searches by user. The brand index
-- helps the bell / project list scope query that fans out from a
-- single user_id.
CREATE INDEX IF NOT EXISTS idx_user_brands_brand ON user_brands(brand);
