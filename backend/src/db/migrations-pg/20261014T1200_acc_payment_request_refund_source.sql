-- 20261014T1200_acc_payment_request_refund_source.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_acc_payment_requests_refund_source;
--           ALTER TABLE scm.acc_payment_requests DROP CONSTRAINT IF EXISTS acc_payment_requests_refund_source_chk;
--           ALTER TABLE scm.acc_payment_requests DROP COLUMN IF EXISTS refund_source_doc_no,
--                                                DROP COLUMN IF EXISTS refund_source_type;
--   Revert the code first: routes/so-money-routes.ts raises a refund request
--   with these columns, lib/refund-request.ts (read by lib/so-money.ts and
--   lib/pv-refund.ts) holds an order's money while one waits, and
--   routes/payment-requests.ts selects them (COLS). Dropping them turns every
--   refund request into a plain request with no order behind it — return or
--   withdraw the waiting ones first.
--   GRANTS: none to re-apply — columns, a check and an index ride their table's grants.
--
-- WHAT THIS CHANGES: two nullable columns on scm.acc_payment_requests —
--   refund_source_type ('SO') and refund_source_doc_no, the Sales Order whose
--   money a refund request gives back — a check that they come together, and a
--   partial index for the money panel's read of an order's refund requests.
--   Every existing request reads NULL (not a refund).
--
-- WHY (owner 2026-10-14): 「sales order 的 refund request 可以让他跑去 payment
--   request，而不是直接去 draft pv 吗？因为我可能还会拒绝 … 同时也要确定他在申请人
--   的 payment request … A，做」 — the Refund button on an order raises a payment
--   request that Finance answers with a Customer Refund voucher, or returns
--   (rejects); while it waits it holds the order's money.
--
-- Verified against: staging (minnapsemfzjmtvnnvdd) via apply_migration before merge.

ALTER TABLE scm.acc_payment_requests
  ADD COLUMN IF NOT EXISTS refund_source_type text,
  ADD COLUMN IF NOT EXISTS refund_source_doc_no text;

DO $$ BEGIN
  ALTER TABLE scm.acc_payment_requests ADD CONSTRAINT acc_payment_requests_refund_source_chk
    CHECK ((refund_source_type IS NULL AND refund_source_doc_no IS NULL)
        OR (refund_source_type = 'SO' AND refund_source_doc_no IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_acc_payment_requests_refund_source
  ON scm.acc_payment_requests (company_id, refund_source_doc_no)
  WHERE refund_source_doc_no IS NOT NULL;
