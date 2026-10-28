-- ----------------------------------------------------------------------------
-- 0147_scm_settle_pi_paid_centi.sql
--
-- scm.settle_pi_paid_centi — the ONE write path for "move a purchase invoice's
-- paid_centi by this much", with the upper bound clamped by the DATABASE.
--
-- WHY THIS EXISTS
--   Posting a SUPPLIER_PAYMENT voucher settles each linked purchase invoice
--   (backend/src/scm/routes/payment-vouchers.ts). The old shape was, in
--   application code:
--
--     read the PI            -> outstanding = total_centi - paid_centi
--     apply = min(want, outstanding)
--     read paid_centi again  -> write paid_centi + apply
--
--   The sum of allocations WITHIN one voucher is capped at the voucher total,
--   so one voucher alone is safe. TWO vouchers settling the SAME purchase
--   invoice are not. Both read the same paid_centi, both compute the same
--   `outstanding`, and both then apply their full share against a cap that was
--   already true when they read it and false by the time they wrote:
--
--     PI total 10,000 / paid 0
--     PV-A reads outstanding 10,000, PV-B reads outstanding 10,000
--     PV-A writes paid 10,000        PV-B writes paid 20,000
--
--   The invoice is now paid twice over. Note this is NOT a lost update — the
--   existing optimistic gate (`.eq('paid_centi', prev)`) makes sure BOTH
--   increments land, which is precisely the problem. The stale value is the
--   CAP, not the addend, so retrying harder makes it worse, not better.
--   Supplier reconciliation is where you find out, months later.
--
--   HOOKKA fixed this class in BUG-2026-05-21-001 by moving the arithmetic
--   into the database — `SET paidAmount = GREATEST(0, paidAmount - ?)` — so
--   concurrent settles serialise in Postgres instead of racing in Workers.
--   This is the mirror image: the bound being clamped is the UPPER one,
--   LEAST(total_centi, paid_centi + delta).
--
-- WHY A ROW LOCK AND NOT A BARE SINGLE-STATEMENT UPDATE
--   `UPDATE ... SET paid_centi = LEAST(total_centi, paid_centi + $1)` is a
--   single statement and would be race-free on its own. It cannot tell the
--   caller HOW MUCH it actually applied, because RETURNING sees only the new
--   row and Postgres before 18 has no OLD in RETURNING. That number is not
--   optional here: the caller writes it to pv_allocations.applied_centi, and a
--   later voucher cancel reverses exactly that figure. Recording the REQUESTED
--   amount after the database clamped it to something smaller would leave the
--   cancel un-applying money that was never applied — trading an over-payment
--   for an under-payment.
--
--   So the read and the write sit inside one function body (= one implicit
--   transaction) with SELECT ... FOR UPDATE taking the row lock. A concurrent
--   settle against the same PI blocks at that SELECT until this one commits,
--   then re-reads the committed row — so it sees the first voucher's payment
--   and clamps against the real remaining balance. Same serialisation as the
--   single-statement form, and it can report what it did. The sibling
--   scm.apply_customer_credit_to_si takes the same shape (it uses an advisory
--   lock; FOR UPDATE is stricter here because there is a single row to lock).
--
-- CLAMPING IS REPORTED, NOT SWALLOWED
--   applied_centi < the requested delta means an over-allocation was refused.
--   Silently absorbing that would replace one lie (paid_centi > total_centi)
--   with another (a voucher claiming to have settled more than it did), so the
--   function returns both numbers and the caller logs the difference. A clamp
--   is a real event a human needs to see, not a detail of the implementation.
--
-- NEGATIVE DELTAS (a voucher cancel reversing its settlement) keep the old
--   GREATEST(0, ...) floor and take NO upper clamp. A PI whose paid_centi is
--   already above total_centi from a legacy double-settle must still be able
--   to unwind fully; clamping a reversal down to total_centi would strand the
--   excess forever.
--
-- APPLICATION — this file is in backend/src/db/migrations-pg/ and is APPLIED
--   AUTOMATICALLY BY THE DEPLOY, by scripts/pg-migrate.mjs, once, tracked in
--   _pg_migrations. There is nothing to run by hand. It can live here at all
--   only because the migration runner became dollar-quote aware in the same
--   PR (scripts/lib/split-sql.mjs) — before that, splitting on `;\n` shattered
--   any PL/pgSQL body, which is why every stored function in this repo lived
--   outside the migration tree and had to be applied manually.
--
--   settlePiPaidCenti still detects the function's ABSENCE and falls back to
--   the legacy optimistic-loop path, so a database that has not yet taken this
--   migration behaves exactly as it did before. A live RPC error does NOT fall
--   back — see the status-typing note below, which is the one thing that could
--   have produced one.
--
-- ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table
-- data. Safe to re-run.
--
-- search_path pinned to scm on the function so the unqualified table access
-- never resolves to a shadowing public.* table (the bug that broke the ported
-- FIFO trigger). The function ITSELF is schema-qualified, because pg-migrate
-- runs each statement with the deploy role's default search_path and does not
-- SET one — the hand-run apply script used to do that, and a migration cannot
-- rely on it.
--
-- STATUS IS AN ENUM, NOT text. scm.purchase_invoices.status is
-- scm.purchase_invoice_status ('DRAFT' added by migration 0044, plus POSTED /
-- PARTIALLY_PAID / PAID / CANCELLED). Postgres has no assignment cast from
-- text to an enum, so `SET status = <a text variable>` would raise at CALL
-- time — and settlePiPaidCenti does not fall back on a live RPC error, so
-- every settlement would have failed rather than quietly degrading. The new
-- status is therefore written as an inline CASE of bare literals, which the
-- planner coerces to whatever type the column actually is, and read back out
-- with RETURNING status::text for the text-typed return column. Same rule,
-- expressed once, in a form that does not depend on the column's type.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION scm.settle_pi_paid_centi(
  p_pi_id uuid,
  p_delta bigint
) RETURNS TABLE(
  applied_centi   bigint,
  new_paid_centi  bigint,
  new_status      text,
  reason          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
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
  SELECT COALESCE(paid_centi, 0), COALESCE(total_centi, 0), status::text
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
    -- total by an unrelated settle — this function only ever moves paid_centi
    -- in the direction of the delta it was given.
    v_new_paid := GREATEST(v_old_paid, LEAST(v_total, v_old_paid + p_delta));
  ELSE
    v_new_paid := GREATEST(0, v_old_paid + p_delta);
  END IF;

  UPDATE purchase_invoices
     SET paid_centi = v_new_paid,
         status     = CASE
                        WHEN v_new_paid >= v_total THEN 'PAID'
                        WHEN v_new_paid > 0        THEN 'PARTIALLY_PAID'
                        ELSE                            'POSTED'
                      END,
         updated_at = now()
   WHERE id = p_pi_id
  RETURNING status::text INTO v_new_status;

  RETURN QUERY SELECT (v_new_paid - v_old_paid), v_new_paid, v_new_status, NULL::text;
END;
$$;

-- PostgREST reaches the function through the same roles the scm REST client uses.
GRANT EXECUTE ON FUNCTION scm.settle_pi_paid_centi(uuid, bigint)
  TO anon, authenticated, service_role;

-- PostgREST caches the schema; nudge it so sb.rpc() resolves the new function
-- immediately after the deploy rather than at the next periodic reload.
NOTIFY pgrst, 'reload schema';
