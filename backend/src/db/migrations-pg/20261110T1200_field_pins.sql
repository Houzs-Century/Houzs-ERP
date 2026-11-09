-- 20261110T1200_field_pins.sql
-- REVERSAL: DROP TABLE IF EXISTS public.field_pins;
--   Revert the code first: routes/fieldPinLogin.ts (POST /api/auth/pin-login)
--   and routes/fieldPinAdmin.ts (/api/field-pin) read and write it. Dropping it
--   removes every crew PIN; those members then sign in with email + password as
--   before. Sessions minted at the PIN door carry sessions.origin = 'field'; to
--   end them too: DELETE FROM sessions WHERE origin = 'field'.
--   GRANTS: none to restore (this file only revokes anon / authenticated).
--
-- WHAT THIS CHANGES: one new empty table; nothing existing is altered.
--
-- WHY (issue #5459 R3, crew PIN sign-in). Helpers and drivers often have no
-- usable email, and sign-in was email-only. A crew member whose Title is a
-- Driver / Helper Title can now sign in with their staff code (EMP-0042) and a
-- 6-digit PIN an admin sets on their Team profile.
--   pin_hash      PBKDF2, the same algorithm and record shape as users.password_hash.
--   failed_count  wrong PINs since the last correct one (or since a lock ran out).
--   locked_until  set when failed_count reaches 5: no PIN is checked until then,
--                 15 minutes. Lives on the row, not in KV, so it holds when KV is
--                 down. A new PIN set by an admin clears both.
--   set_by/set_at who issued the current PIN and when (audit_events has the history).
-- A separate table rather than columns on users on purpose: writes to users fire
-- the scm.staff sync trigger, and a failed-try counter must not.
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS public.field_pins (
  user_id       integer     PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  pin_hash      text        NOT NULL,
  failed_count  integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  set_by        integer,
  set_at        timestamptz NOT NULL DEFAULT now()
);

-- PIN hashes: never readable through the PostgREST anon / authenticated roles.
-- RLS deliberately not enabled, same reasoning as auth_failed_logins.
REVOKE ALL ON public.field_pins FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.field_pins FROM anon; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON public.field_pins FROM authenticated; END IF; END $$;
