-- 0099: POS auth on Houzs — PIN store + brute-force limiter for /api/pos/pin-login.
--
-- WHY
--   To retire the 2990 backend, the 2990 POS must log into HOUZS. Houzs uses its
--   own session auth (sessions table, integer user id), NOT Supabase Auth. This
--   gives counter staff a 6-digit PIN login that mints a Houzs session:
--     POST /api/pos/pin-login {staffId, pin} -> verify -> createSession(user_id).
--   staffId is an scm.staff uuid (what /api/pos/sales-staff lists); we map it to
--   the linked public.users integer via scm.staff.user_id (from 0066) and mint a
--   session for THAT user, so the POS caller becomes a real Houzs user.
--
-- HOUZS CONVENTIONS (same as 0066/0057)
--   schema-qualified; no inner BEGIN/COMMIT (pg-migrate owns the txn); additive &
--   re-runnable; SET search_path; and EVERY internal ';' in a PL/pgSQL body ends
--   with '-- $' so pg-migrate's /;\s*\n/ splitter cannot carve the function.
--
-- The RPC contract matches scm/lib/pin-rate-limit.ts exactly:
--   pin_attempt_check(p_staff_id text, p_max int) -> (allowed, retry_after, remaining)
--   pin_attempt_fail(p_staff_id text, p_window_seconds int) -> void
--   pin_attempt_reset(p_staff_id text) -> void
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) PIN store, keyed by scm.staff.id (uuid) — what sales-staff + pin-login use.
CREATE TABLE IF NOT EXISTS scm.pos_pins (
  staff_id   uuid PRIMARY KEY REFERENCES scm.staff(id) ON DELETE CASCADE,
  pin_hash   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) Durable, globally-consistent brute-force state (the limiter's backing table).
CREATE TABLE IF NOT EXISTS scm.pos_pin_attempts (
  staff_id     text PRIMARY KEY,
  fail_count   integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

-- 3a) check: is this staff allowed another attempt? (60s rolling window)
CREATE OR REPLACE FUNCTION scm.pin_attempt_check(p_staff_id text, p_max integer)
RETURNS TABLE(allowed boolean, retry_after integer, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count integer; -- $
  v_start timestamptz; -- $
  v_age   integer; -- $
BEGIN
  SELECT fail_count, window_start INTO v_count, v_start
    FROM scm.pos_pin_attempts WHERE staff_id = p_staff_id; -- $
  IF NOT FOUND THEN
    RETURN QUERY SELECT true, 0, p_max; -- $
    RETURN; -- $
  END IF; -- $
  v_age := EXTRACT(EPOCH FROM (now() - v_start))::integer; -- $
  IF v_age >= 60 THEN
    RETURN QUERY SELECT true, 0, p_max; -- $
    RETURN; -- $
  END IF; -- $
  IF v_count >= p_max THEN
    RETURN QUERY SELECT false, GREATEST(60 - v_age, 1), 0; -- $
  ELSE
    RETURN QUERY SELECT true, 0, (p_max - v_count); -- $
  END IF; -- $
END $$;

-- 3b) fail: record a failed attempt (reset the window if it has elapsed)
CREATE OR REPLACE FUNCTION scm.pin_attempt_fail(p_staff_id text, p_window_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO scm.pos_pin_attempts (staff_id, fail_count, window_start)
  VALUES (p_staff_id, 1, now())
  ON CONFLICT (staff_id) DO UPDATE
    SET fail_count = CASE WHEN now() - scm.pos_pin_attempts.window_start >= make_interval(secs => p_window_seconds)
                         THEN 1 ELSE scm.pos_pin_attempts.fail_count + 1 END,
        window_start = CASE WHEN now() - scm.pos_pin_attempts.window_start >= make_interval(secs => p_window_seconds)
                           THEN now() ELSE scm.pos_pin_attempts.window_start END; -- $
END $$;

-- 3c) reset: clear the counter on a successful login
CREATE OR REPLACE FUNCTION scm.pin_attempt_reset(p_staff_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM scm.pos_pin_attempts WHERE staff_id = p_staff_id; -- $
END $$;
