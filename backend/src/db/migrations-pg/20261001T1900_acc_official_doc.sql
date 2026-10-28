-- 20261001T1900_acc_official_doc.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_payment_vouchers_official_doc;
--           DROP INDEX IF EXISTS scm.idx_ap_invoices_official_doc;
--           ALTER TABLE scm.payment_vouchers DROP COLUMN IF EXISTS official_doc,
--             DROP COLUMN IF EXISTS official_doc_note, DROP COLUMN IF EXISTS official_doc_at,
--             DROP COLUMN IF EXISTS official_doc_by;
--           ALTER TABLE scm.ap_invoices DROP COLUMN IF EXISTS official_doc,
--             DROP COLUMN IF EXISTS official_doc_note, DROP COLUMN IF EXISTS official_doc_at,
--             DROP COLUMN IF EXISTS official_doc_by;
--           ALTER TABLE scm.acc_payment_request_files DROP COLUMN IF EXISTS kind;
--           ALTER TABLE scm.acc_pv_files DROP COLUMN IF EXISTS kind;
--           ALTER TABLE scm.acc_ap_invoice_files DROP COLUMN IF EXISTS kind;
--   Revert the code first: lib/official-doc.ts, routes/official-docs.ts, the
--   voucher and AP invoice create doors and the payment-request routes read and
--   write these columns. Dropping them forgets which payments still owe their
--   official invoice; the files themselves stay (their `kind` read as a bill).
--   GRANTS: none — columns on existing tables ride those tables' grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the columns and both indexes read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four nullable
-- columns on each of payment_vouchers and ap_invoices, one defaulted column on
-- each of the three file indexes, two partial indexes; no existing row is
-- written (every file reads as a bill, which is what each was; no payment owes
-- anything until Finance marks it).
--
-- WHY (owner 2026-10-01, payment-request item 3 → 做): 他们有时是给 proforma
-- invoice, 这样我要 follow up 回 original 单 — Finance (never the requester) marks
-- a payment made on a proforma or quotation as owing its official invoice; a
-- list shows every one still owed (Finance all, a requester their own); the
-- official invoice uploaded later is copied to the payment and waits for
-- Finance to check it; the ledger is never touched.
--   • official_doc       — OWED (marked) → RECEIVED (uploaded, to check) →
--                          CHECKED (Finance checked it); NULL = nothing owed;
--   • official_doc_note  — what the reader found against the proforma, or
--                          Finance's own note when checking;
--   • official_doc_at/by — the last change and who made it;
--   • kind on each file index — 'bill' (as attached) or 'official' (the
--     official invoice that came later), so a print and a screen can say which.

SET search_path = public, scm;

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS official_doc text CHECK (official_doc IS NULL OR official_doc IN ('OWED', 'RECEIVED', 'CHECKED')),
  ADD COLUMN IF NOT EXISTS official_doc_note text,
  ADD COLUMN IF NOT EXISTS official_doc_at timestamptz,
  ADD COLUMN IF NOT EXISTS official_doc_by text;
ALTER TABLE scm.ap_invoices
  ADD COLUMN IF NOT EXISTS official_doc text CHECK (official_doc IS NULL OR official_doc IN ('OWED', 'RECEIVED', 'CHECKED')),
  ADD COLUMN IF NOT EXISTS official_doc_note text,
  ADD COLUMN IF NOT EXISTS official_doc_at timestamptz,
  ADD COLUMN IF NOT EXISTS official_doc_by text;

ALTER TABLE scm.acc_payment_request_files
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'official'));
ALTER TABLE scm.acc_pv_files
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'official'));
ALTER TABLE scm.acc_ap_invoice_files
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'official'));

CREATE INDEX IF NOT EXISTS idx_payment_vouchers_official_doc
  ON scm.payment_vouchers (company_id) WHERE official_doc IN ('OWED', 'RECEIVED');
CREATE INDEX IF NOT EXISTS idx_ap_invoices_official_doc
  ON scm.ap_invoices (company_id) WHERE official_doc IN ('OWED', 'RECEIVED');
