-- 20260907T1705_pv_customer_refund_columns.sql
-- REVERSAL: ALTER TABLE scm.payment_vouchers DROP COLUMN IF EXISTS refund_source_type, DROP COLUMN IF EXISTS refund_source_doc_no, DROP COLUMN IF EXISTS customer_id, DROP COLUMN IF EXISTS debtor_code; DROP INDEX IF EXISTS scm.payment_vouchers_refund_source_idx;
--   GRANTS: none to re-apply — the table's existing privileges cover new columns.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Four NULLable columns and one partial index on scm.payment_vouchers.
--   Every existing row reads NULL in all four; nothing is rewritten.
--
-- WHY (owner 2026-09-07; the value itself landed in 20260907T1700). A
-- Customer Refund voucher must say WHICH document it refunds and WHO the
-- customer is, in the shape the sales side already uses — 认单为主 (the
-- owner picks the Sales Order or the cancelled Sales Invoice; the form shows
-- what that document collected), 主要是要有办法链接相关的订单资料:
--   • refund_source_type    — 'SO' or 'SI'; NULL on every other voucher.
--   • refund_source_doc_no  — the SO doc_no / SI invoice_number refunded.
--                             The refundable headroom is the money THIS
--                             ledger booked for that document minus every
--                             non-cancelled refund voucher already on it —
--                             read by number, hence the index.
--   • customer_id           — mfg_sales_orders.customer_id when the SO has
--                             one (2990's orders all do; 117 customers since
--                             June); NULL for an SI, whose customer is its
--                             debtor code.
--   • debtor_code           — the customer's debtor code when the document
--                             carries one (HOUZS invoices do; 2990's orders
--                             carry none). The AR leg's party code, and the
--                             key of the customer_credits row the refund
--                             writes when there is one to write.
-- payee_name keeps the customer's name, as it keeps the supplier's.
--
-- Additive + idempotent (IF NOT EXISTS).

SET search_path = scm, public;

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS refund_source_type   text,
  ADD COLUMN IF NOT EXISTS refund_source_doc_no text,
  ADD COLUMN IF NOT EXISTS customer_id          uuid,
  ADD COLUMN IF NOT EXISTS debtor_code          text;

DO $$ BEGIN
  ALTER TABLE scm.payment_vouchers
    ADD CONSTRAINT payment_vouchers_refund_source_type_check
    CHECK (refund_source_type IS NULL OR refund_source_type IN ('SO', 'SI'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS payment_vouchers_refund_source_idx
  ON scm.payment_vouchers (company_id, refund_source_doc_no)
  WHERE refund_source_doc_no IS NOT NULL;
