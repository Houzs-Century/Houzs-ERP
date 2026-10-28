-- 0167: repair the PIN brute-force RPCs against the LIVE pos_pin_attempts shape.
--
-- WHY
--   0099 wrote scm.pin_attempt_check/fail/reset(p_staff_id text, ...) against a
--   table it expected to create itself:
--     (staff_id text PK, fail_count int, window_start timestamptz)
--   But scm.pos_pin_attempts ALREADY existed — imported from 2990 during the SCM
--   merge with the shape
--     (staff_id uuid PK -> scm.staff, count int, reset_at timestamptz)
--   so 0099's CREATE TABLE IF NOT EXISTS no-op'd, and every PIN attempt since the
--   #949/#966 flip has errored inside the RPCs:
--     ERROR: column "fail_count" does not exist            (check / fail)
--     ERROR: operator does not exist: uuid = text          (reset)
--   pos.ts wraps all three calls in try/catch (fail-open by design), so PIN login
--   still worked for staff with PINs — but with NO brute-force limiting at all,
--   and a pair of postgres errors logged on every single attempt.
--
--   The worker binds the staff id as an untyped string, which Postgres resolves
--   to the TEXT overloads (the broken 0099 ones), never the uuid overloads the
--   2990 port script left behind. So: rewrite the TEXT-signature bodies in place
--   to operate on the real columns. reset_at = the instant the window EXPIRES
--   (2990 semantics — fail() stamps now()+window), not the window start.
--   p_staff_id is ::uuid-cast — safe: pos.ts rejects non-UUID staffIds (UUID_RE)
--   before any of these run.
--
-- HOUZS CONVENTIONS (same as 0099)
--   schema-qualified; no inner BEGIN/COMMIT (pg-migrate owns the txn); additive &
--   re-runnable; and EVERY internal ';' in a PL/pgSQL body ends with '-- $' so
--   pg-migrate's /;\s*\n/ splitter cannot carve the function.
--   SECURITY DEFINER now pins search_path (the 0099 versions left it unset).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) check: is this staff allowed another attempt?
CREATE OR REPLACE FUNCTION scm.pin_attempt_check(p_staff_id text, p_max integer)
RETURNS TABLE(allowed boolean, retry_after integer, remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
DECLARE
  v_count integer; -- $
  v_reset timestamptz; -- $
BEGIN
  SELECT a.count, a.reset_at INTO v_count, v_reset
    FROM scm.pos_pin_attempts a WHERE a.staff_id = p_staff_id::uuid; -- $
  IF NOT FOUND OR v_reset <= now() THEN
    RETURN QUERY SELECT true, 0, p_max; -- $
    RETURN; -- $
  END IF; -- $
  IF v_count >= p_max THEN
    RETURN QUERY SELECT false, GREATEST(CEIL(EXTRACT(EPOCH FROM (v_reset - now())))::integer, 1), 0; -- $
  ELSE
    RETURN QUERY SELECT true, 0, (p_max - v_count); -- $
  END IF; -- $
END $$;

-- 2) fail: record a failed attempt (start a fresh window if the old one expired)
CREATE OR REPLACE FUNCTION scm.pin_attempt_fail(p_staff_id text, p_window_seconds integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
BEGIN
  INSERT INTO scm.pos_pin_attempts (staff_id, count, reset_at)
  VALUES (p_staff_id::uuid, 1, now() + make_interval(secs => p_window_seconds))
  ON CONFLICT (staff_id) DO UPDATE
    SET count = CASE WHEN scm.pos_pin_attempts.reset_at <= now()
                     THEN 1 ELSE scm.pos_pin_attempts.count + 1 END,
        reset_at = CASE WHEN scm.pos_pin_attempts.reset_at <= now()
                        THEN now() + make_interval(secs => p_window_seconds)
                        ELSE scm.pos_pin_attempts.reset_at END; -- $
END $$;

-- 3) reset: clear the counter on a successful login
CREATE OR REPLACE FUNCTION scm.pin_attempt_reset(p_staff_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
BEGIN
  DELETE FROM scm.pos_pin_attempts WHERE staff_id = p_staff_id::uuid; -- $
END $$;
