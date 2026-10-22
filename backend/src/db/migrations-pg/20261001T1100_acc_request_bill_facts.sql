-- 20261001T1100_acc_request_bill_facts.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_acc_payment_requests_bill;
--           DROP INDEX IF EXISTS scm.idx_payment_vouchers_bill;
--           ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS bill_no,
--             DROP COLUMN IF EXISTS bill_date, DROP COLUMN IF EXISTS bill_total_sen,
--             DROP COLUMN IF EXISTS event_bill, DROP COLUMN IF EXISTS no_event_reason;
--           ALTER TABLE scm.payment_vouchers DROP COLUMN IF EXISTS bill_ref,
--             DROP COLUMN IF EXISTS bill_date;
--   Revert the code first: routes/payment-requests.ts, routes/payment-vouchers.ts
--   (HEADER selects bill_ref and bill_date) and lib/bill-matches.ts read and write
--   these columns. Dropping them loses only what the bill reader read; the bills
--   themselves stay in their file tables.
--   GRANTS: none — columns on existing tables ride those tables' grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the columns and both indexes read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: seven new
-- nullable or defaulted columns and two partial indexes; no existing row is
-- written or altered (event_bill defaults to false, which is what every request
-- raised so far was: none was read).
--
-- WHY (owner 2026-10-01, payment-request item 1 → 做): a request must carry its
-- bill, and the bill is READ when it is attached — its own number, date and
-- total. Two things hang on that reading:
--   • 同一张单上传两次 — the same bill asked for or paid twice is said out loud
--     (never refused: one bill paid as a deposit and a balance is normal). The
--     owner's rule: match on the bill's NUMBER and DATE, not on payee and amount,
--     which repeat honestly. A voucher keeps the same two facts (bill_ref,
--     bill_date) so a bill paid straight from a voucher is matched too; an AP
--     invoice already has them (supplier_invoice_ref, invoice_date).
--   • a bill printed for an exhibition / fair / roadshow (event_bill) needs its
--     Event before it goes to Finance — or the requester's one-line reason why
--     there is none (no_event_reason).

SET search_path = public, scm;

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS bill_no text,
  ADD COLUMN IF NOT EXISTS bill_date date,
  ADD COLUMN IF NOT EXISTS bill_total_sen bigint CHECK (bill_total_sen IS NULL OR bill_total_sen >= 0),
  ADD COLUMN IF NOT EXISTS event_bill boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS no_event_reason text;
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_bill
  ON scm.acc_payment_requests (company_id, bill_date) WHERE bill_date IS NOT NULL;

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS bill_ref text,
  ADD COLUMN IF NOT EXISTS bill_date date;
CREATE INDEX IF NOT EXISTS idx_payment_vouchers_bill
  ON scm.payment_vouchers (company_id, bill_date) WHERE bill_date IS NOT NULL;
