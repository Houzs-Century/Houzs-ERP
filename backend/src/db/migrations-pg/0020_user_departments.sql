-- Multi-department membership.
--
-- `users.department_id` stays the PRIMARY department (drives colour, position
-- lockstep, sales-rep sync, org-chart lineage). This join table carries the
-- FULL set of departments a user belongs to — the primary is treated as one
-- of the set. Mirrors the user_brands (mig 049) join-table pattern.
--
-- Idempotent: applied to the live DB on deploy by pg-migrate.mjs (runs before
-- the worker). IF NOT EXISTS / ON CONFLICT throughout so re-applying is a no-op.
CREATE TABLE IF NOT EXISTS user_departments (
  user_id       integer NOT NULL,
  department_id integer NOT NULL,
  created_at    text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  PRIMARY KEY (user_id, department_id)
);

-- Reverse lookup ("who is in department X"). The (user_id, department_id) PK
-- already serves user_id-prefixed lookups, so no separate user index is needed.
CREATE INDEX IF NOT EXISTS idx_user_departments_dept ON user_departments (department_id);

-- Seed the set from each user's existing primary department so the join table
-- is consistent at rest for all current members. Derived from prod data, not
-- demo seed — keeps the primary-in-set invariant true without a code backfill.
INSERT INTO user_departments (user_id, department_id)
SELECT id, department_id FROM users WHERE department_id IS NOT NULL
ON CONFLICT (user_id, department_id) DO NOTHING;
