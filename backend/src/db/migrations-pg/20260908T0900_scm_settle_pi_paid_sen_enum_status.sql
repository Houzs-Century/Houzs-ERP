-- 20260908T0900_scm_settle_pi_paid_sen_enum_status.sql
-- REVERSAL: re-create scm.settle_pi_paid_sen with the body 0305_money_centi_to_sen.sql
--   installs at its lines 752-810 (the status CASE of bare text literals) — which
--   brings back the 42804 failure on every call, so nothing ever wants it. No
--   table data is touched here: the allocations the failure left at applied_sen 0
--   are settled by scripts/repair-pi-settlement.mjs (plan/apply), and a voucher
--   CANCEL undoes each of those by settling the negative of applied_sen, as it
--   does for any voucher. GRANTS: none to re-apply — CREATE OR REPLACE keeps the
--   function's ACL (0147 granted EXECUTE to anon, authenticated, service_role);
--   the grant below is the same statement, repeated so the file stands alone.
--
-- WHAT WENT WRONG (docs/bugs/0700). Approving a SUPPLIER_PAYMENT voucher settles
-- each purchase invoice it pays through this function (lib/pi-settlement.ts →
-- rpc settle_pi_paid_sen). scm.purchase_invoices.status is the enum
-- scm.purchase_invoice_status, and the UPDATE wrote it as
--
--     status = CASE WHEN ... THEN 'PAID' WHEN ... THEN 'PARTIALLY_PAID' ELSE 'POSTED' END
--
-- 0147 chose that shape on purpose, believing the planner would coerce bare
-- literals to the column's type. It does for ONE bare literal. A CASE whose
-- branches are all untyped literals is resolved first, on its own, and the rule
-- for that is "all unknown → text"; the UPDATE then needs an ASSIGNMENT cast
-- from text to the enum, and Postgres has none (the automatic I/O cast FROM a
-- string type is explicit-only). So every call raised
--
--     42804: column "status" is of type purchase_invoice_status but expression is of type text
--
-- and settlePiPaidSen — which correctly refuses to fall back to the optimistic
-- loop on a live RPC error — recorded applied_sen 0 and logged. The voucher
-- itself was fine: its journal entry was already posted and the money did
-- leave. What never moved was the invoice: paid_sen stayed 0, the status stayed
-- POSTED, the invoice stayed open in the AP Payment picker and unlocked for
-- edits, and a later cancel of the voucher would have "un-applied" nothing.
-- Reproduced 2026-09-08 on staging against the live definition (a probe inside
-- a DO block, rolled back on purpose): the exact error above, from the exact
-- UPDATE above. On prod the same error sits in the Postgres logs behind every
-- SUPPLIER_PAYMENT approval, and 21 allocations (two vouchers, RM 46,948.10)
-- carry applied_sen 0 against invoices still POSTED at paid_sen 0.
--
-- Why no test caught it: tests-pg/pvRateAdoption.pg.test.ts runs this function
-- against real Postgres — on a fixture that declared `status text`. The fixture
-- was not the table. tests-pg/settlePiPaidSenEnum.pg.test.ts now declares the
-- enum and pins the latest definition in this tree.
--
-- THE FIX is one cast per branch. Everything else — the row lock, the clamp,
-- the DRAFT/CANCELLED refusal, the returned figures — is 0305's body verbatim.
-- scm.settle_api_paid_sen (20260906T1500) is NOT touched: ap_invoices.status
-- is text, and that twin has been settling AP invoices correctly all along.
--
-- Idempotent: CREATE OR REPLACE with an unchanged signature and return type.

CREATE OR REPLACE FUNCTION scm.settle_pi_paid_sen(p_pi_id uuid, p_delta bigint)
 RETURNS TABLE(applied_sen bigint, new_paid_sen bigint, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_old_paid   bigint;
  v_total      bigint;
  v_status     text;
  v_new_paid   bigint;
  v_new_status text;
BEGIN
  IF p_pi_id IS NULL OR p_delta IS NULL OR p_delta = 0 THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'no_delta'::text; RETURN;
  END IF;

  -- The lock that makes this safe. A second settle against this PI waits here
  -- and then reads the row THIS transaction committed, not the one it started
  -- with, so its clamp is computed against the true remaining balance.
  SELECT COALESCE(paid_sen, 0), COALESCE(total_sen, 0), status::text
    INTO v_old_paid, v_total, v_status
    FROM purchase_invoices
   WHERE id = p_pi_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'not_found'::text; RETURN;
  END IF;

  -- A DRAFT or CANCELLED invoice is not a live liability — unchanged behaviour.
  IF upper(COALESCE(v_status, '')) IN ('DRAFT', 'CANCELLED') THEN
    RETURN QUERY SELECT 0::bigint, v_old_paid, v_status, 'not_live'::text; RETURN;
  END IF;

  IF p_delta > 0 THEN
    -- LEAST caps the over-payment. The outer GREATEST stops a PI that is
    -- ALREADY over total (legacy data) from being silently pulled DOWN to
    -- total by an unrelated settle — this function only ever moves paid_sen
    -- in the direction of the delta it was given.
    v_new_paid := GREATEST(v_old_paid, LEAST(v_total, v_old_paid + p_delta));
  ELSE
    v_new_paid := GREATEST(0, v_old_paid + p_delta);
  END IF;

  -- The status is an ENUM. Each branch is typed as one, so the CASE resolves to
  -- the column's own type and the assignment needs no cast that does not exist.
  UPDATE purchase_invoices
     SET paid_sen   = v_new_paid,
         status     = CASE
                        WHEN v_new_paid >= v_total THEN 'PAID'::scm.purchase_invoice_status
                        WHEN v_new_paid > 0        THEN 'PARTIALLY_PAID'::scm.purchase_invoice_status
                        ELSE                            'POSTED'::scm.purchase_invoice_status
                      END,
         updated_at = now()
   WHERE id = p_pi_id
  RETURNING status::text INTO v_new_status;

  RETURN QUERY SELECT (v_new_paid - v_old_paid), v_new_paid, v_new_status, NULL::text;
END;
$function$;

GRANT EXECUTE ON FUNCTION scm.settle_pi_paid_sen(uuid, bigint)
  TO anon, authenticated, service_role;
