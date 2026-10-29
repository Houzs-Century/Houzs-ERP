-- 20261029T0900_acc_other_debtor_credit_notes.sql
-- REVERSAL: revert the code first (acc/credit-notes.ts kind OCN,
--   acc/credit-note-allocations.ts ODB targets, routes/credit-notes.ts). Cancel
--   every OCN note on file before reverting — its knock-offs give received_sen
--   back through scm.settle_odb_received_sen with the negative; the old CHECKs
--   refuse to come back while an OCN row or a debtor-bill allocation stands. Then:
--     DROP FUNCTION IF EXISTS scm.settle_odb_received_sen(uuid, bigint);
--     DROP INDEX IF EXISTS scm.idx_acc_cn_alloc_debtor_bill;
--     ALTER TABLE scm.acc_credit_note_allocations DROP CONSTRAINT acc_credit_note_allocations_one_target;
--     ALTER TABLE scm.acc_credit_note_allocations ADD CONSTRAINT acc_credit_note_allocations_one_target
--       CHECK ((purchase_invoice_id IS NULL) <> (ap_invoice_id IS NULL));
--     ALTER TABLE scm.acc_credit_note_allocations DROP COLUMN IF EXISTS debtor_bill_id;
--     DROP INDEX IF EXISTS scm.idx_acc_credit_notes_debtor;
--     ALTER TABLE scm.acc_credit_notes DROP CONSTRAINT acc_credit_notes_party_type_check;
--     ALTER TABLE scm.acc_credit_notes ADD CONSTRAINT acc_credit_notes_party_type_check
--       CHECK (party_type = ANY (ARRAY['CUSTOMER'::text, 'SUPPLIER'::text]));
--     ALTER TABLE scm.acc_credit_notes DROP CONSTRAINT acc_credit_notes_kind_check;
--     ALTER TABLE scm.acc_credit_notes ADD CONSTRAINT acc_credit_notes_kind_check
--       CHECK (kind = ANY (ARRAY['CN'::text, 'DN'::text, 'SCN'::text]));
--     ALTER TABLE scm.acc_credit_notes DROP COLUMN IF EXISTS debtor_id;
--   GRANTS: the function's EXECUTE to service_role is granted below; the columns
--   ride the tables' existing privileges.
-- Verified against: PRODUCTION, inside one transaction ROLLED BACK — this file run
--   by backend/scripts/try-migration-ocn.mjs (branch acc/commission-check,
--   run-script.yml run 40700720691, 2026-10-28): the existing CHECKs were named
--   acc_credit_notes_kind_check / _party_type_check / acc_credit_note_allocations_
--   one_target as dropped here; the columns, FKs, indexes and widened CHECKs read
--   back; an OCN note, line and debtor-bill allocation written; the function moved
--   HC-ODB-2608-005 0 → 200000 → 0 and clamped at its total (PAID); a two-target,
--   a no-target, kind XCN and party OTHER refused; nothing left after rollback.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- nullable columns, two CHECKs widened (every existing row passes the new ones),
-- the allocation CHECK rewritten to say the same thing for the two existing
-- targets plus the new one, two partial indexes and one new function. No row is
-- written or altered.
--
-- WHY (owner 2026-10-28: Customer & Other Debtor CN / DN beside Supplier & Other
-- Creditor CN / DN — 「可以」; AutoCount's CN-2609-025 gives other debtor EASTERN
-- DECORATOR a RM 2,000 discount). A credit note may be TO an other debtor — kind
-- OCN: Dr each line's account / Cr the other-debtor control (305-0000) for that
-- debtor — and its credit comes off the debtor's bills the way a debtor receipt's
-- money does (received_sen), one allocation row per bill, applied_sen recording
-- what the settle moved so a cancel gives back exactly that.

ALTER TABLE scm.acc_credit_notes ADD COLUMN IF NOT EXISTS debtor_id uuid REFERENCES scm.acc_debtors(id) ON DELETE RESTRICT;
ALTER TABLE scm.acc_credit_notes DROP CONSTRAINT IF EXISTS acc_credit_notes_kind_check;
ALTER TABLE scm.acc_credit_notes ADD CONSTRAINT acc_credit_notes_kind_check
  CHECK (kind = ANY (ARRAY['CN'::text, 'DN'::text, 'SCN'::text, 'OCN'::text]));
ALTER TABLE scm.acc_credit_notes DROP CONSTRAINT IF EXISTS acc_credit_notes_party_type_check;
ALTER TABLE scm.acc_credit_notes ADD CONSTRAINT acc_credit_notes_party_type_check
  CHECK (party_type = ANY (ARRAY['CUSTOMER'::text, 'SUPPLIER'::text, 'ODEBTOR'::text]));
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_debtor ON scm.acc_credit_notes (debtor_id) WHERE debtor_id IS NOT NULL;

ALTER TABLE scm.acc_credit_note_allocations ADD COLUMN IF NOT EXISTS debtor_bill_id uuid REFERENCES scm.acc_debtor_bills(id) ON DELETE RESTRICT;
ALTER TABLE scm.acc_credit_note_allocations DROP CONSTRAINT IF EXISTS acc_credit_note_allocations_one_target;
ALTER TABLE scm.acc_credit_note_allocations ADD CONSTRAINT acc_credit_note_allocations_one_target
  CHECK (num_nonnulls(purchase_invoice_id, ap_invoice_id, debtor_bill_id) = 1);
CREATE INDEX IF NOT EXISTS idx_acc_cn_alloc_debtor_bill ON scm.acc_credit_note_allocations (debtor_bill_id) WHERE debtor_bill_id IS NOT NULL;

-- A debtor bill's received_sen moved by a credit note, the way settle_api_paid_sen
-- moves an AP invoice's paid_sen: the row locked, the move clamped to the bill
-- (never past its total, never below nil), the status following — PAID when
-- nothing is owed, POSTED otherwise; a CANCELLED bill takes nothing.
CREATE OR REPLACE FUNCTION scm.settle_odb_received_sen(p_id uuid, p_delta bigint)
 RETURNS TABLE(applied_sen bigint, new_received_sen bigint, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_old        bigint;
  v_total      bigint;
  v_status     text;
  v_new        bigint;
  v_new_status text;
BEGIN
  IF p_id IS NULL OR p_delta IS NULL OR p_delta = 0 THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'no_delta'::text; RETURN;
  END IF;

  SELECT COALESCE(received_sen, 0), COALESCE(total_sen, 0), status
    INTO v_old, v_total, v_status
    FROM acc_debtor_bills
   WHERE id = p_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'not_found'::text; RETURN;
  END IF;

  IF upper(COALESCE(v_status, '')) = 'CANCELLED' THEN
    RETURN QUERY SELECT 0::bigint, v_old, v_status, 'not_live'::text; RETURN;
  END IF;

  IF p_delta > 0 THEN
    v_new := GREATEST(v_old, LEAST(v_total, v_old + p_delta));
  ELSE
    v_new := GREATEST(0, v_old + p_delta);
  END IF;

  UPDATE acc_debtor_bills
     SET received_sen = v_new,
         status       = CASE WHEN v_new >= v_total THEN 'PAID' ELSE 'POSTED' END
   WHERE id = p_id
  RETURNING status INTO v_new_status;

  RETURN QUERY SELECT (v_new - v_old), v_new, v_new_status, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION scm.settle_odb_received_sen(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.settle_odb_received_sen(uuid, bigint) TO service_role;
