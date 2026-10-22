-- 20260930T1000_acc_payment_request_ap_invoice.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_acc_payment_requests_ap_invoice;
--           ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS ap_invoice_id;
--   Revert the code first (routes/payment-requests.ts, lib/payment-request.ts and
--   the AP invoice create door read and write this column). The AP invoices made
--   from requests stay; only the request's pointer to its invoice goes, and such a
--   request then reads as "Submitted" again until the column returns.
--   GRANTS: none — a column on an existing table rides that table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-09-30; the column, its foreign key and the index read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column and one partial index on scm.acc_payment_requests; no existing
-- row is written or altered.
--
-- WHY (owner 2026-09-30, 6.1-6.4 → 做): a request may be answered by an AP INVOICE
-- as well as by a payment voucher — a supplier's bill is booked first (AP) and
-- paid later by an AP Payment, a direct cost is paid at once (PV). ap_invoice_id
-- names that invoice the way pv_id names the voucher; a request points at ONE live
-- document at a time (the link clears the other pointer), so one bill is never
-- paid twice from a request. What the requester reads on this path — booked,
-- partly paid (RM x of y), paid, bank confirmed — is read off the invoice and the
-- AP Payments that paid it, never stored here. status stays as it is: VOUCHERED
-- now means "answered by a document", whichever kind.

SET search_path = public, scm;

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS ap_invoice_id uuid REFERENCES scm.ap_invoices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_ap_invoice
  ON scm.acc_payment_requests (ap_invoice_id) WHERE ap_invoice_id IS NOT NULL;
