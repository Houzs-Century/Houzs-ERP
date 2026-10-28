-- 043_backfill_project_pic.sql
-- Legacy rows created before migration 039 have pic_id = NULL. Without
-- a PIC the scoped ACL (pic_id IN [self, manager_id]) can't match them,
-- which is why "Sales Person" users see zero projects on fresh deploys.
--
-- Backfill pic_id = created_by so every project has an owner. Admins
-- can still reassign via the project's PIC picker afterwards. Only
-- touches rows where pic_id is still NULL — never overrides an
-- already-assigned PIC.

UPDATE projects
   SET pic_id = created_by,
       updated_at = datetime('now')
 WHERE pic_id IS NULL
   AND created_by IS NOT NULL;
