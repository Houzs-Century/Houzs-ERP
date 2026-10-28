-- 0016_seed_storekeeper_role.sql
--
-- Seed the Storekeeper role row needed by the ported fleet features.
--
-- The pre-cutover branch (feat/checklist-amendments) REFERENCES a
-- 'Storekeeper' role by name in two places but never seeded it (it was
-- created by hand via the Roles UI on the old D1 prod):
--   * backend/src/services/fleet.ts — crew dropdown includes Storekeeper
--   * backend/src/routes/projects.ts — "my pending tasks" maps storekeeper
--     to the DRIVER task scope
--
-- Per owner steering, user-management / positions / roles stay on current
-- main and the branch's roles / page-access data is NOT imported. The only
-- concession is adding the minimal role ROW the Fleet feature needs. We add
-- it as a job-function tag only (permissions '[]'); real page access for any
-- Storekeeper user is granted through their POSITION (current-main model),
-- which the owner controls.
--
-- Idempotent via a NOT EXISTS guard (NOT ON CONFLICT): the live prod roles
-- table was loaded from the D1-dump conversion and has no UNIQUE constraint
-- on name, so ON CONFLICT (name) has nothing to match. NOT EXISTS re-runs
-- safely and leaves a Storekeeper role the owner may have created by hand
-- untouched (we never clobber the owner's roles).

INSERT INTO roles (name, description, permissions, is_system, scope_to_pic)
SELECT
  'Storekeeper',
  'Warehouse stock staff — handles stock in/out and appears in the project crew picker.',
  '[]',
  0,
  0
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Storekeeper');
