-- 20261001T1500_acc_request_installments.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.uq_acc_payment_requests_installment;
--           DROP INDEX IF EXISTS scm.idx_acc_payment_requests_parent;
--           ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS parent_request_id,
--             DROP COLUMN IF EXISTS installment_no, DROP COLUMN IF EXISTS pay_pct;
--   Revert the code first: routes/payment-requests.ts and lib/payment-request.ts
--   read and write these columns (the balance door, the family figures, the bill a
--   balance borrows from its first request). Dropping them turns every balance
--   request into a request of its own — still answered, still paid — that no
--   longer says which bill's balance it is.
--   GRANTS: none — columns on an existing table ride that table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the columns and both indexes read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: three new
-- columns (one nullable foreign key, one integer defaulting to 1, one nullable
-- percentage) and two indexes; no existing row is written (each request raised
-- so far becomes instalment 1 of its own bill, which is what it was).
--
-- WHY (owner 2026-10-01, payment-request item 2 → 做): 一张单付两次 — 我不想要他们
-- 上传两次. The first request names the bill (its total read off it) and how much
-- is paid now — an amount or a percent; the balance is a NEW request on the same
-- bill, raised from the first with one button (申请付余额), carrying no second
-- upload. Each instalment is still one request answered by one voucher (or paid
-- on the bill's AP invoice), so everything a request already does — stages,
-- return, withdraw — holds per instalment.
--   • parent_request_id — the bill's FIRST request (null on the first itself);
--   • installment_no    — 1 for the first, then 2, 3… per bill; unique per bill
--                         so two presses of 申请付余额 cannot both be instalment 2;
--   • pay_pct           — the percent the requester typed, kept for reading
--                         ("50%"); the amount asked is still amount_sen.

SET search_path = public, scm;

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS parent_request_id uuid REFERENCES scm.acc_payment_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS installment_no integer NOT NULL DEFAULT 1 CHECK (installment_no >= 1),
  ADD COLUMN IF NOT EXISTS pay_pct numeric(6,2) CHECK (pay_pct IS NULL OR (pay_pct > 0 AND pay_pct <= 100));
CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_parent
  ON scm.acc_payment_requests (parent_request_id) WHERE parent_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_acc_payment_requests_installment
  ON scm.acc_payment_requests (company_id, (coalesce(parent_request_id, id)), installment_no);
