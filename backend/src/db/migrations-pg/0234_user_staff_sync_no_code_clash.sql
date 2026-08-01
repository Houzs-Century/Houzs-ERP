-- 0234: Disabling a member must not be able to fail on scm.staff.staff_code.
--
-- SYMPTOM
--   Team > Members > Disable returned "Something went wrong processing that
--   request. Please try again." and the account stayed ACTIVE. Same for the
--   soft-delete path (DELETE /api/users/:id without ?hard=1), which also writes
--   status='disabled', and for any rename of an affected member.
--
-- ROOT CAUSE
--   PATCH /api/users/:id runs a bare `UPDATE users SET status='disabled'`.
--   0066 put `trg_sync_user_to_staff` on public.users as
--   AFTER INSERT OR UPDATE OF name, status, mirroring the user into scm.staff:
--
--       UPDATE scm.staff SET ... WHERE id = <deterministic uuid> OR user_id = NEW.id;
--       IF NOT FOUND THEN INSERT INTO scm.staff (...) ON CONFLICT (id) DO UPDATE ...;
--
--   The UPDATE branch is safe -- name/active/initials carry no constraints.
--   The INSERT branch is not: scm.staff carries
--   `staff_staff_code_unique UNIQUE(staff_code)` (see
--   scripts/scm-schema/2990s-full-schema.sql), and an ON CONFLICT clause can
--   only name ONE arbiter -- 0066 named the primary key (id). So when the
--   generated `'EMP-' || lpad(id,4,'0')` is already held by a DIFFERENT staff
--   row, Postgres raises `duplicate key value violates unique constraint
--   "staff_staff_code_unique"`. The trigger runs inside the firing statement,
--   so the users UPDATE rolls back with it and the member is never disabled.
--   backend/src/index.ts maps that error class to the generic 500 the operator
--   saw, which is why the real reason never reached the screen.
--
--   Evidence: backend/scripts/check-user-disable-blocked.mjs (+ the
--   "User disable blocked check (read-only)" workflow) reports, per user,
--   whether a linked staff row exists and whether the wanted staff_code is
--   already taken -- i.e. exactly the two conditions above.
--
-- FIX (this migration -- function body only)
--   1. DEACTIVATING A USER WITH NO STAFF ROW IS A NO-OP. There is nothing to
--      switch off, and minting an inactive staff row purely to satisfy a
--      disable is what turned a routine status change into a write that could
--      fail. This alone unblocks Disable and the soft-delete path.
--   2. WHEN A ROW IS GENUINELY NEEDED (insert / re-enable), pick a staff_code
--      that is actually free instead of assuming the derived one is. The
--      preferred code is unchanged, so nothing is renamed; only a colliding
--      code falls back to a suffixed variant.
--
--   The ID-MAPPING INVARIANT from 0066 is untouched: the staff row's id is
--   still md5('houzs-user:' || u.id)::uuid, so `salesperson_id = scm.staff.id`
--   still holds and existing rows keep their code.
--
-- SCOPE
--   ADDITIVE + IDEMPOTENT -- one CREATE OR REPLACE FUNCTION. No DDL on any
--   table, no data written, no trigger recreated (0066's trigger already points
--   at this function by name). Re-runnable.
--
--   NOT repaired here: users that currently have no linked scm.staff row stay
--   unlinked. Creating rows for them would add people to the SO Salesperson
--   picker as a side effect of a bug fix, which is the owner's call, not this
--   migration's. Run the check workflow to see who they are.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.sync_user_to_staff() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_id       uuid;
  v_active   boolean;
  v_name     text;
  v_initials text;
  v_code     text;
  v_try      integer := 0;
BEGIN
  v_id     := md5('houzs-user:' || NEW.id::text)::uuid;
  -- "Active" = not soft-deleted. 'invited' users (never logged in) still count,
  -- mirroring 0060, so a newly-invited salesperson is pickable immediately.
  v_active := (NEW.status <> 'disabled');
  v_name   := COALESCE(NULLIF(btrim(NEW.name), ''), NEW.email, 'User ' || NEW.id::text);
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
    ) parts;

  UPDATE scm.staff
     SET name = v_name, active = v_active, initials = v_initials
   WHERE id = v_id OR user_id = NEW.id;
  IF FOUND THEN
    RETURN NEW;
  END IF;

  -- No linked staff row. Switching OFF a user who has nothing to switch off is
  -- a no-op -- and it must be, because the INSERT below is the only part of
  -- this trigger that can raise, and a failure here aborts the users UPDATE
  -- that fired it.
  IF NOT v_active THEN
    RETURN NEW;
  END IF;

  -- staff_code is UNIQUE, and ON CONFLICT can only arbitrate on the primary
  -- key here, so a code held by another row would raise duplicate key. Probe
  -- for a free one; the preferred code is tried first, so existing behaviour is
  -- unchanged whenever it is available.
  v_code := 'EMP-' || lpad(NEW.id::text, 4, '0');
  WHILE EXISTS (SELECT 1 FROM scm.staff WHERE staff_code = v_code) LOOP
    v_try := v_try + 1;
    EXIT WHEN v_try > 50;
    v_code := 'EMP-' || lpad(NEW.id::text, 4, '0') || '-' || v_try::text;
  END LOOP;

  INSERT INTO scm.staff (id, user_id, staff_code, name, role, initials, color, active)
  VALUES (
    v_id,
    NEW.id,
    v_code,
    v_name,
    'sales'::scm.staff_role,
    v_initials,
    -- Deterministic hex colour from the id so a person's chip is stable.
    '#' || substr(md5('houzs-user:' || NEW.id::text), 1, 6),
    v_active
  )
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name, active = EXCLUDED.active,
        initials = EXCLUDED.initials, user_id = EXCLUDED.user_id;

  RETURN NEW;
END $$;
