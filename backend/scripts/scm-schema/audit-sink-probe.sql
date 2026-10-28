-- ----------------------------------------------------------------------------
-- scm.entity_audit_writable — answers ONE question truthfully before a business
-- write happens: "if I try to append to scm.entity_audit_log right now, will it
-- work?"
--
-- WHY THIS EXISTS
--   The owner's ruling (2026-07-19): a user must never believe an edit succeeded
--   when its audit record did not get written. "如果人家改了单，就不可以失败呀。那如果
--   失败的话，你就要跳出警告，跟他说'你失败了，请重新操作'。"
--
--   The obvious implementation — let recordEntityAudit throw — is a LIE. Every
--   one of its 22 call sites in the money/stock modules runs AFTER the business
--   write has already committed (deliberately: the placement comments at those
--   sites explain why). Telling the operator "you failed, please redo" at that
--   point makes them post the same payment voucher twice.
--
--   The honest order is therefore: ask FIRST, write second. If the audit sink is
--   not writable we refuse before touching anything, and "please redo" is then a
--   true statement about a document that genuinely did not change.
--
-- WHY A FUNCTION AND NOT A SELECT
--   A plain `select ... limit 1` on the table proves only that the database is
--   reachable and the table is visible. It does NOT prove the sink accepts an
--   INSERT — the failure mode that actually matters. The observed production
--   failures here are reachability (Hyperdrive cold start, Supavisor outage) AND
--   shape drift (a database that never received migration 0139, a stale PostgREST
--   schema cache), and only the second class needs a real insert to detect.
--
--   So this probes with a REAL insert and then throws it away. The inner
--   BEGIN/EXCEPTION block is a subtransaction: when the sentinel exception is
--   caught, every database change made inside the block is rolled back. The probe
--   therefore exercises the true write path — grants, NOT NULLs, defaults, the
--   schema cache — and leaves NO row behind. THE TABLE STAYS APPEND-ONLY: this
--   never commits a row, so it never needs to delete one.
--
--   The sentinel uses a private SQLSTATE (AU001) rather than a message match, so
--   a genuine error raised by the INSERT itself can never be mistaken for the
--   rollback signal. Anything other than AU001 means the insert really failed.
--
-- WHAT IT STILL CANNOT PROMISE
--   Time passes between the probe and the real insert, so a sink that dies in
--   that window still leaves a change saved and unrecorded. That window is NOT
--   closed here and is not closed anywhere yet: telling the operator about it
--   needs a warning carried on a SUCCESS response, which this API has no
--   convention for. recordEntityAudit returns whether it recorded so that work
--   has a hook; until then the case is logged loudly and named in BUG-HISTORY.
--   What it must NEVER become is "please redo" — the change did happen.
--
-- APPLICATION — STAGING FIRST (owner rule: data/schema ops go to staging before
--   prod). This is NOT in the auto-applied backend/src/db/migrations-pg/ tree and
--   is NOT run on deploy, for the same reason the customer-credit precedent is
--   not: it is a SECURITY DEFINER function and wants a human to watch it land.
--     node scripts/scm-schema/apply-audit-sink-probe.mjs
--   The calling code (assertAuditWritable) detects the function's ABSENCE and
--   falls back to a reachability-only SELECT probe, so merging this code before
--   the function is applied weakens the check but never breaks a handler.
--
-- ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table data.
-- Safe to re-run.
--
-- search_path pinned to scm so the unqualified table write cannot resolve to a
-- shadowing public.* table (the bug that broke the ported FIFO trigger).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION entity_audit_writable(
  p_entity_type text,
  p_entity_id   text,
  p_action      text,
  p_company_id  bigint DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_ok boolean := false;
BEGIN
  BEGIN
    -- The probe row is shaped like the row the caller is about to write, so a
    -- company-scoped or type-specific rejection is caught here rather than after
    -- the business write. source='probe' is never observable — the rollback
    -- below removes this row before anyone can read it.
    INSERT INTO entity_audit_log
      (company_id, entity_type, entity_id, entity_doc_no, action,
       actor_id, actor_name_snapshot, field_changes, status_snapshot, source, note)
    VALUES
      (p_company_id, COALESCE(p_entity_type, 'PROBE'), COALESCE(p_entity_id, 'probe'),
       NULL, COALESCE(p_action, 'UPDATE'),
       NULL, NULL, '[]'::jsonb, NULL, 'probe', NULL);

    -- Sentinel: unwinds the subtransaction, discarding the insert above. Reaching
    -- this line at all is the proof that the insert succeeded.
    RAISE EXCEPTION 'audit_probe_rollback' USING ERRCODE = 'AU001';
  EXCEPTION
    WHEN SQLSTATE 'AU001' THEN
      v_ok := true;
    WHEN OTHERS THEN
      -- The INSERT itself failed: missing table, missing grant, constraint, stale
      -- schema. The sink is not writable and the caller must refuse.
      v_ok := false;
  END;

  RETURN v_ok;
END;
$$;

-- PostgREST reaches the function through the same roles the scm REST client uses.
GRANT EXECUTE ON FUNCTION entity_audit_writable(text, text, text, bigint)
  TO anon, authenticated, service_role;
