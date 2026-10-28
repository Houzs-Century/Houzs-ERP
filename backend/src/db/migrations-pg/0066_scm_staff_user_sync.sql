-- 0066: User Management -> SCM salesperson auto-sync (scm.staff).
--
-- WHY
--   The SO Salesperson dropdown (mobile + desktop) reads scm.staff via GET
--   /api/scm/staff. Until now scm.staff held ONLY the seeded super_admin system
--   row (00000000-0000-4000-8000-000000000001, user_id NULL) that the SCM auth
--   bridge pins every caller to -- so the picker showed exactly ONE person.
--   The real people live in public.users (User Management) and were never synced
--   into scm.staff. This mirrors 0060 (Driver/Helper -> scm.drivers/scm.helpers)
--   for salespeople -> scm.staff.
--
-- ID-MAPPING INVARIANT (the load-bearing part)
--   The SO write stamps `salesperson_id` with the picked staff row's id, and the
--   picker lists scm.staff by that id, so the invariant that must hold is
--   `salesperson_id === scm.staff.id`. In 2990 (native Supabase Auth) both staff
--   and users share ONE uuid; in Houzs they DIVERGE -- scm.staff.id is a uuid,
--   public.users.id is an INTEGER serial. We therefore give every user a
--   DETERMINISTIC staff uuid derived from its integer id:
--       md5('houzs-user:' || u.id)::uuid
--   Deterministic => the same user always maps to the same staff uuid, so the
--   backfill and the trigger converge and are safely re-runnable. A `user_id`
--   link column (mirrors 0060's scm.drivers.user_id) records the source user for
--   auditing + trigger lookups. The dead `/mine` route ("staff.id === auth id",
--   integer) is already inert in Houzs -- the bridge pins every SCM caller to the
--   system staff row -- so nothing that currently works is disturbed.
--
-- SCOPE DECISION (FLAGGED for the owner)
--   Syncs ALL non-disabled users (status <> 'disabled'), NOT a sales-only filter.
--   0060 filters by position NAME (driver/helper); there is no equally clean
--   "salesperson" position convention to key on here, and the owner can pick
--   anyone as a salesperson today. So we sync everyone active now and let the
--   owner narrow later (e.g. add `AND lower(p.name) IN (...sales positions...)`).
--   role defaults to 'sales'::scm.staff_role (the picker only needs a valid enum).
--
-- HOUZS CONVENTIONS
--   schema-qualified (scm.*); no inner BEGIN/COMMIT (pg-migrate owns the txn);
--   IF NOT EXISTS / ON CONFLICT for additive idempotency; SET search_path so
--   unqualified refs in the function body resolve to scm.*. EVERY internal ';'
--   in the PL/pgSQL body carries a trailing '-- $' line-comment so pg-migrate's
--   /;\s*\n/ splitter cannot carve the function into broken pieces (same guard
--   0057 uses).
--
-- DEPENDENCIES (already present)
--   scm.staff (id uuid PK, staff_code/name/role/initials/color NOT NULL),
--   scm.staff_role enum ('sales' is a member), public.users (id serial, name,
--   email, status, phone).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) Link column back to the source user (NULL for the system/manual rows).
ALTER TABLE scm.staff ADD COLUMN IF NOT EXISTS user_id integer;
-- One staff row per user. NULLs (system row, any manual rows) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_user_id ON scm.staff(user_id) WHERE user_id IS NOT NULL;

-- 2) Sync function. Runs on users INSERT/UPDATE; upserts the matching staff row
--    by its DETERMINISTIC uuid and (de)activates it with the user's status.
CREATE OR REPLACE FUNCTION scm.sync_user_to_staff() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id       uuid; -- $
  v_active   boolean; -- $
  v_name     text; -- $
  v_initials text; -- $
BEGIN
  v_id     := md5('houzs-user:' || NEW.id::text)::uuid; -- $
  -- "Active" = not soft-deleted. 'invited' users (never logged in) still count,
  -- mirroring 0060, so a newly-invited salesperson is pickable immediately.
  v_active := (NEW.status <> 'disabled'); -- $
  v_name   := COALESCE(NULLIF(btrim(NEW.name), ''), NEW.email, 'User ' || NEW.id::text); -- $
  -- Initials: first char of up to the first two whitespace-split name words,
  -- uppercased; fall back to the first two chars of the resolved name.
  SELECT upper(COALESCE(NULLIF(string_agg(left(w, 1), '' ORDER BY ord), ''), left(v_name, 2)))
    INTO v_initials
    FROM (
      SELECT w, ord
        FROM regexp_split_to_table(v_name, '\s+') WITH ORDINALITY AS t(w, ord)
       WHERE w <> ''
       ORDER BY ord
       LIMIT 2
    ) parts; -- $

  UPDATE scm.staff
     SET name = v_name, active = v_active, initials = v_initials
   WHERE id = v_id OR user_id = NEW.id; -- $
  IF NOT FOUND THEN
    INSERT INTO scm.staff (id, user_id, staff_code, name, role, initials, color, active)
    VALUES (
      v_id,
      NEW.id,
      'EMP-' || lpad(NEW.id::text, 4, '0'),
      v_name,
      'sales'::scm.staff_role,
      v_initials,
      -- Deterministic hex colour from the id so a person's chip is stable.
      '#' || substr(md5('houzs-user:' || NEW.id::text), 1, 6),
      v_active
    )
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name, active = EXCLUDED.active,
          initials = EXCLUDED.initials, user_id = EXCLUDED.user_id; -- $
  END IF; -- $

  RETURN NEW; -- $
END $$;

-- 3) Fire on insert + the columns that affect the staff row (name/status).
DROP TRIGGER IF EXISTS trg_sync_user_to_staff ON public.users;
CREATE TRIGGER trg_sync_user_to_staff
  AFTER INSERT OR UPDATE OF name, status ON public.users
  FOR EACH ROW EXECUTE FUNCTION scm.sync_user_to_staff();

-- 4) Backfill every currently-active user. Keeps the system super_admin row
--    (user_id NULL) untouched. Deterministic id => re-runnable.
INSERT INTO scm.staff (id, user_id, staff_code, name, role, initials, color, active)
SELECT
  md5('houzs-user:' || u.id::text)::uuid,
  u.id,
  'EMP-' || lpad(u.id::text, 4, '0'),
  COALESCE(NULLIF(btrim(u.name), ''), u.email, 'User ' || u.id::text),
  'sales'::scm.staff_role,
  upper(left(COALESCE(NULLIF(btrim(u.name), ''), u.email, 'U'), 2)),
  '#' || substr(md5('houzs-user:' || u.id::text), 1, 6),
  true
FROM public.users u
WHERE u.status <> 'disabled'
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name, active = EXCLUDED.active, user_id = EXCLUDED.user_id;
