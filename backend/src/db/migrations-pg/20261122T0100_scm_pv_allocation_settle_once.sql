-- 20261122T0100_scm_pv_allocation_settle_once.sql
-- REVERSAL: revert the payment-voucher code that calls these first, then
--   DROP FUNCTION scm.settle_pv_allocation(uuid); DROP FUNCTION scm.unsettle_pv_allocation(uuid);
--   DROP FUNCTION scm.apply_supplier_advance(uuid, bigint, jsonb);
--   ALTER TABLE scm.pv_allocations DROP COLUMN settled_at;
-- GRANTS: new functions only; EXECUTE is revoked from PUBLIC and granted to service_role at the end
--   (the shape of scm.settle_api_paid_sen). Dropping them removes the grants with them.
--
-- A payment voucher's invoice settlement happens exactly once, even when the post dies part-way
-- and is pressed again. Ported from Conts-ERP migration 0355 (its PR #1137, items D1, D2, D12).
--
-- THE BUGS (backend/src/scm/routes/payment-vouchers.ts before this change).
--   Post   wrote the journal, then marked the voucher POSTED, then settled each allocation with a
--          separate call. A post that died after the journal never settled its invoices, and a
--          retry found the journal, answered "already posted" and skipped the settlement for good.
--          The fix needs to know, per allocation, whether it has been settled. applied_sen cannot
--          say: it is NOT NULL DEFAULT 0, and 0 is also what a settled allocation reads when the
--          invoice was already paid in full. Hence settled_at.
--   Cancel reversed each allocation with one call and zeroed applied_sen with another; a death
--          between the two reversed the invoice and kept the record, so a retry reversed it again.
--   Apply-advance settled the invoices first and burned the advance afterwards with a
--          compare-and-set. Two applies at once both settled their invoices; the second burn
--          missed, so the same advance paid two sets of invoices.
--
-- THE FIX. Each step is one function call, so each is one transaction:
--   settle_pv_allocation    locks the allocation; if settled_at is set, answers what was applied and
--                           changes nothing; else settles the PI or AP invoice (the existing clamp)
--                           and stamps applied_sen + settled_at in the same transaction.
--   unsettle_pv_allocation  the reverse: takes exactly applied_sen back off the invoice, then zeroes
--                           applied_sen and clears settled_at. Re-running it is a no-op.
--   apply_supplier_advance  locks the advance row first, refuses (P0415) when the ask exceeds what
--                           remains, settles, writes the from-advance allocations already settled,
--                           and burns the advance by what was applied. All or nothing.
--
-- BACKFILL. An allocation of a POSTED voucher is marked settled when the post visibly settled it:
--   applied_sen > 0, or nothing was asked (amount_sen <= 0), or it is a from-advance knock-off
--   (written already applied). A POSTED voucher's allocation with amount_sen > 0 and applied_sen = 0
--   stays unsettled on purpose: that is exactly the row a post that died, or the 42804 failure of
--   20260908T0900, left behind, and the voucher page now offers Finish posting for it (one press
--   settles it once, clamped at what the invoice still owes). A legitimately clamped-to-zero row
--   (the invoice was already paid in full) settles to 0 again on that press, which moves nothing.
--   Allocations of DRAFT and CANCELLED vouchers stay unsettled.

SET search_path = scm, public;

ALTER TABLE scm.pv_allocations ADD COLUMN IF NOT EXISTS settled_at timestamptz;

UPDATE scm.pv_allocations a
   SET settled_at = COALESCE(v.posted_at, a.created_at)
  FROM scm.payment_vouchers v
 WHERE v.id = a.pv_id
   AND v.status::text = 'POSTED'
   AND a.settled_at IS NULL
   AND (COALESCE(a.applied_sen, 0) > 0 OR COALESCE(a.amount_sen, 0) <= 0 OR a.from_advance IS TRUE);

CREATE OR REPLACE FUNCTION scm.settle_pv_allocation(p_alloc_id uuid)
 RETURNS TABLE(applied bigint, asked bigint, already_settled boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_alloc   scm.pv_allocations%ROWTYPE;
  v_applied bigint := 0;
  v_reason  text;
BEGIN
  SELECT * INTO v_alloc FROM scm.pv_allocations WHERE id = p_alloc_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, false, 'not_found'::text; RETURN;
  END IF;
  IF v_alloc.settled_at IS NOT NULL THEN
    RETURN QUERY SELECT v_alloc.applied_sen, v_alloc.amount_sen, true, NULL::text; RETURN;
  END IF;

  IF COALESCE(v_alloc.amount_sen, 0) > 0 THEN
    IF v_alloc.ap_invoice_id IS NOT NULL THEN
      SELECT s.applied_sen, s.reason INTO v_applied, v_reason
        FROM scm.settle_api_paid_sen(v_alloc.ap_invoice_id, v_alloc.amount_sen) s;
    ELSIF v_alloc.pi_id IS NOT NULL THEN
      SELECT s.applied_sen, s.reason INTO v_applied, v_reason
        FROM scm.settle_pi_paid_sen(v_alloc.pi_id, v_alloc.amount_sen) s;
    END IF;
  END IF;
  v_applied := COALESCE(v_applied, 0);

  UPDATE scm.pv_allocations SET applied_sen = v_applied, settled_at = now() WHERE id = p_alloc_id;
  RETURN QUERY SELECT v_applied, v_alloc.amount_sen, false, v_reason;
END
$function$;

CREATE OR REPLACE FUNCTION scm.unsettle_pv_allocation(p_alloc_id uuid)
 RETURNS TABLE(reversed bigint, recorded bigint, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_alloc    scm.pv_allocations%ROWTYPE;
  v_applied  bigint := 0;
  v_reason   text;
BEGIN
  SELECT * INTO v_alloc FROM scm.pv_allocations WHERE id = p_alloc_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 'not_found'::text; RETURN;
  END IF;
  IF COALESCE(v_alloc.applied_sen, 0) <= 0 THEN
    UPDATE scm.pv_allocations SET settled_at = NULL WHERE id = p_alloc_id AND settled_at IS NOT NULL;
    RETURN QUERY SELECT 0::bigint, 0::bigint, NULL::text; RETURN;
  END IF;

  IF v_alloc.ap_invoice_id IS NOT NULL THEN
    SELECT s.applied_sen, s.reason INTO v_applied, v_reason
      FROM scm.settle_api_paid_sen(v_alloc.ap_invoice_id, -v_alloc.applied_sen) s;
  ELSIF v_alloc.pi_id IS NOT NULL THEN
    SELECT s.applied_sen, s.reason INTO v_applied, v_reason
      FROM scm.settle_pi_paid_sen(v_alloc.pi_id, -v_alloc.applied_sen) s;
  END IF;

  UPDATE scm.pv_allocations SET applied_sen = 0, settled_at = NULL WHERE id = p_alloc_id;
  RETURN QUERY SELECT -COALESCE(v_applied, 0), v_alloc.applied_sen, v_reason;
END
$function$;

-- p_wants: [{"pi_id": uuid|null, "ap_invoice_id": uuid|null, "amount_sen": int}, ...]
CREATE OR REPLACE FUNCTION scm.apply_supplier_advance(p_pv_id uuid, p_company_id bigint, p_wants jsonb)
 RETURNS TABLE(pi_id uuid, ap_invoice_id uuid, asked bigint, applied bigint, remaining bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_adv       scm.acc_supplier_advances%ROWTYPE;
  v_want      jsonb;
  v_pi        uuid;
  v_api       uuid;
  v_amount    bigint;
  v_got       bigint;
  v_asked     bigint := 0;
  v_total     bigint := 0;
  v_remaining bigint;
BEGIN
  SELECT * INTO v_adv FROM scm.acc_supplier_advances
   WHERE acc_supplier_advances.pv_id = p_pv_id::text AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This voucher holds no advance.' USING ERRCODE = 'P0415';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM scm.payment_vouchers v WHERE v.id = p_pv_id AND v.status::text = 'POSTED') THEN
    RAISE EXCEPTION 'Only a posted voucher''s advance can be applied.' USING ERRCODE = 'P0415';
  END IF;

  SELECT COALESCE(sum(GREATEST(0, COALESCE((w->>'amount_sen')::bigint, 0))), 0) INTO v_asked
    FROM jsonb_array_elements(COALESCE(p_wants, '[]'::jsonb)) w;
  v_remaining := v_adv.amount_sen - v_adv.applied_sen;
  IF v_asked > v_remaining THEN
    RAISE EXCEPTION 'Only % sen of this advance remains; % sen was asked.', v_remaining, v_asked
      USING ERRCODE = 'P0415', DETAIL = json_build_object('remaining', v_remaining, 'asked', v_asked)::text;
  END IF;

  FOR v_want IN SELECT * FROM jsonb_array_elements(COALESCE(p_wants, '[]'::jsonb))
  LOOP
    v_pi     := NULLIF(v_want->>'pi_id', '')::uuid;
    v_api    := NULLIF(v_want->>'ap_invoice_id', '')::uuid;
    v_amount := COALESCE((v_want->>'amount_sen')::bigint, 0);
    v_got    := 0;
    CONTINUE WHEN v_amount <= 0 OR (v_pi IS NULL AND v_api IS NULL);
    IF v_api IS NOT NULL THEN
      SELECT s.applied_sen INTO v_got FROM scm.settle_api_paid_sen(v_api, v_amount) s;
    ELSE
      SELECT s.applied_sen INTO v_got FROM scm.settle_pi_paid_sen(v_pi, v_amount) s;
    END IF;
    v_got := COALESCE(v_got, 0);
    IF v_got > 0 THEN
      INSERT INTO scm.pv_allocations (company_id, pv_id, pi_id, ap_invoice_id, amount_sen, applied_sen, from_advance, settled_at)
      VALUES (p_company_id, p_pv_id, CASE WHEN v_api IS NULL THEN v_pi END, v_api, v_got, v_got, true, now());
      v_total := v_total + v_got;
    END IF;
    pi_id := CASE WHEN v_api IS NULL THEN v_pi END; ap_invoice_id := v_api; asked := v_amount; applied := v_got;
    remaining := NULL;
    RETURN NEXT;
  END LOOP;

  UPDATE scm.acc_supplier_advances
     SET applied_sen = applied_sen + v_total, updated_at = now()
   WHERE id = v_adv.id;

  pi_id := NULL; ap_invoice_id := NULL; asked := v_asked; applied := v_total;
  remaining := v_remaining - v_total;
  RETURN NEXT;
END
$function$;

-- SECURITY DEFINER functions are executable by PUBLIC by default; only the service-role client calls these
-- (as 20260906T1500 does for scm.settle_api_paid_sen).
REVOKE ALL ON FUNCTION scm.settle_pv_allocation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION scm.unsettle_pv_allocation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION scm.apply_supplier_advance(uuid, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.settle_pv_allocation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION scm.unsettle_pv_allocation(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION scm.apply_supplier_advance(uuid, bigint, jsonb) TO service_role;
