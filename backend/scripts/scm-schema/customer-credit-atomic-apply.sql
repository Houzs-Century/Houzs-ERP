-- ----------------------------------------------------------------------------
-- scm.apply_customer_credit_to_si — the ONE atomic write path for "apply a
-- customer's standing credit balance toward a new Sales Invoice".
--
-- WHY THIS EXISTS
--   applyCustomerCreditToSi (backend/src/scm/lib/customer-credits.ts) used to do
--   this as two SEPARATE PostgREST round trips — insert the credit payment row on
--   the SI, then insert the negative APPLIED_TO_SI ledger row — with no
--   transaction around them (there is no BEGIN/COMMIT in backend/src/scm; every
--   sb.from() is its own HTTP call). A crash / dropped connection BETWEEN the two
--   left the invoice paid from a credit that was never debited: the customer kept
--   the balance and could spend it a second time, with no error anywhere. It does
--   not report itself — you find it two months later at reconciliation.
--
--   A function body runs inside a single implicit transaction, so the two inserts
--   here either both commit or both roll back. This is the same atomicity pattern
--   the rest of scm already uses for multi-row writes (create_product_with_pricing,
--   upsert_customer_by_name_phone).
--
-- IDEMPOTENCY
--   A per-SI transaction-scoped advisory lock serialises concurrent applications,
--   and an existence check on the credit payment row makes a retry a no-op. Both
--   sit INSIDE the transaction that does the writes, so unlike the old read-guard
--   (a separate HTTP call that a transient blip could skip) they cannot be raced.
--
-- APPLICATION — STAGING FIRST (owner rule: data/schema ops go to staging before
--   prod). This is NOT in the auto-applied backend/src/db/migrations-pg/ tree and
--   is NOT run on deploy. Apply it by hand, staging then prod:
--     node scripts/scm-schema/apply-customer-credit-atomic.mjs
--   The calling code (applyCustomerCreditToSi) detects the function's ABSENCE and
--   falls back to the legacy two-write path, so merging the code before this runs
--   changes nothing; the atomic path activates the moment the function exists.
--
-- ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only, touches no table data.
-- Safe to re-run.
--
-- search_path pinned to scm so the unqualified table writes never resolve to a
-- shadowing public.* table (the bug that broke the ported FIFO trigger).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION apply_customer_credit_to_si(
  p_debtor_code         text,
  p_si_id               uuid,
  p_si_number           text,
  p_remaining_due_sen integer,
  p_debtor_name         text DEFAULT NULL,
  p_created_by          uuid DEFAULT NULL
) RETURNS TABLE(applied_sen integer, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_company_id integer;
  v_balance    bigint;
  v_apply      integer;
  v_existing   integer;
BEGIN
  IF p_debtor_code IS NULL OR btrim(p_debtor_code) = '' THEN
    RETURN QUERY SELECT 0, 'no_debtor'::text; RETURN;
  END IF;
  IF p_remaining_due_sen IS NULL OR p_remaining_due_sen <= 0 THEN
    RETURN QUERY SELECT 0, 'no_due'::text; RETURN;
  END IF;

  -- Serialise concurrent applications against the SAME invoice: the existence
  -- check + the two inserts below must be one indivisible unit, or two racing
  -- calls each read "no credit payment yet" and both apply. The lock is
  -- transaction-scoped and releases automatically at COMMIT/ROLLBACK.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_si_id::text, 0));

  -- Idempotency — a credit payment already recorded on this SI → no-op.
  SELECT count(*) INTO v_existing
  FROM sales_invoice_payments
  WHERE sales_invoice_id = p_si_id AND method = 'credit';
  IF v_existing > 0 THEN
    RETURN QUERY SELECT 0, 'already_applied'::text; RETURN;
  END IF;

  -- Company inherited from the SI itself (single source of truth — avoids the
  -- separate read whose failure used to let an omitted company_id default to
  -- HOUZS). A missing SI leaves v_company_id NULL and the payment insert's FK
  -- to sales_invoices then fails, rolling the whole call back — never a partial.
  SELECT company_id INTO v_company_id FROM sales_invoices WHERE id = p_si_id;

  -- SCOPED TO THE SI's COMPANY. `debtor_code` is NOT globally unique: mig 0123
  -- re-keyed scm.customers on (customer_code, company_id), so the same code names
  -- a DIFFERENT customer in each company, while customer_credits.company_id is
  -- NOT NULL (mig 0083). Summing on debtor_code alone pooled BOTH companies'
  -- ledgers into one balance while the two INSERTs below stamp v_company_id — so
  -- a company-A invoice could consume a company-B credit row and only the debit
  -- carried a company. The stamp is what made it silent.
  --
  -- v_company_id NULL (the missing-SI case named above) makes this predicate
  -- match nothing, so the call returns 'no_balance' and writes nothing, instead
  -- of reaching the payment insert's FK failure. Both outcomes write nothing;
  -- this one is reached earlier and says why.
  SELECT COALESCE(SUM(amount_sen), 0) INTO v_balance
  FROM customer_credits
  WHERE debtor_code = p_debtor_code AND company_id = v_company_id;
  IF v_balance <= 0 THEN
    RETURN QUERY SELECT 0, 'no_balance'::text; RETURN;
  END IF;

  v_apply := LEAST(v_balance, p_remaining_due_sen::bigint)::integer;
  IF v_apply <= 0 THEN
    RETURN QUERY SELECT 0, 'no_due'::text; RETURN;
  END IF;

  -- The two writes that must move together. One transaction: both land or
  -- neither does.
  INSERT INTO sales_invoice_payments
    (company_id, sales_invoice_id, method, amount_sen, note, created_by)
  VALUES
    (v_company_id, p_si_id, 'credit', v_apply,
     'Applied customer credit balance toward ' || p_si_number, p_created_by);

  INSERT INTO customer_credits
    (company_id, debtor_code, debtor_name, amount_sen,
     source_type, source_doc_no, source_doc_id, notes, created_by)
  VALUES
    (v_company_id, p_debtor_code, p_debtor_name, -v_apply,
     'APPLIED_TO_SI', p_si_number, p_si_id,
     'Auto-applied to ' || p_si_number, p_created_by);

  RETURN QUERY SELECT v_apply, NULL::text;
END;
$$;

-- PostgREST reaches the function through the same roles the scm REST client uses.
GRANT EXECUTE ON FUNCTION apply_customer_credit_to_si(text, uuid, text, integer, text, uuid)
  TO anon, authenticated, service_role;
