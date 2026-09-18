-- 20260915T1800_so_payment_conversions.sql
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.acc_credit_notes_converted_payment_idx;
--   ALTER TABLE scm.acc_credit_notes DROP COLUMN IF EXISTS converted_payment_id;
--   DROP INDEX IF EXISTS scm.mfg_sales_order_payments_converted_from_idx;
--   ALTER TABLE scm.mfg_sales_order_payments DROP COLUMN IF EXISTS converted_from_so_doc_no;
--   Both columns are new and nullable; dropping them loses ONLY the link from
--   a converted payment row to the cancelled order it moved money from, and
--   from a credit note to the conversion that raised it — the rows themselves
--   (the payment on the new order, the note against the old deposit invoice,
--   their journals) stay, as does every figure. GRANTS: none touched — ALTER
--   TABLE keeps the table's ACL.
--
-- WHAT THIS IS FOR (owner 2026-09-15; docs/bugs/0927). A Sales Order is
-- cancelled with money on it. That money has two exits, and the owner wants
-- them side by side: REFUND (part or all — a Customer Refund voucher for
-- Finance, which exists since 2026-09-07) or CONVERT to a new order (part or
-- all; one cancelled order to several new ones, several cancelled orders to
-- one new one). A conversion is a NEW payment row on the new order — method
-- `converted`, the cancelled order's first payment date and collector —
-- naming the order it moved money from:
--
--   mfg_sales_order_payments.converted_from_so_doc_no  → the cancelled order
--
-- so what is left on the cancelled order is read off the ledger, not kept
-- in a column: paid − refunded (vouchers) − converted (rows naming it). The
-- link is to the ORDER, the way a refund voucher's is (refund_source_doc_no):
-- money on an order is one pool, taken oldest-first, and a row that named
-- one payment could not move a sum spanning two.
--
-- Under the deposit-invoice regime (docs/bugs/0828) the money on the old
-- order was invoiced as a deposit; moving it takes it off that invoice by a
-- CREDIT NOTE — the e-invoice shape, never a cancel past 72 hours (docs/
-- bugs/0860 does the same for a refund) — and the new order gets its own
-- deposit invoice. The note remembers which conversion raised it:
--
--   acc_credit_notes.converted_payment_id  → the converted payment row
--
-- beside refund_pv_id, which remembers which refund voucher did. A note with
-- either is a partial taker of the deposit invoice; the close-out at the
-- final invoice and a later refund both read the remainder.
--
-- ADDITIVE. Nothing is backfilled: no conversion exists before this lands.
-- The deployed application keeps working whether or not this has run — the
-- columns are only written by the conversion paths that ship with it.
--
-- Verified against: staging minnapsemfzjmtvnnvdd (apply_migration) — both
-- columns added, both indexes present, every existing row NULL in both.

SET search_path = scm, public;

ALTER TABLE scm.mfg_sales_order_payments
  ADD COLUMN IF NOT EXISTS converted_from_so_doc_no text NULL;

CREATE INDEX IF NOT EXISTS mfg_sales_order_payments_converted_from_idx
  ON scm.mfg_sales_order_payments (company_id, converted_from_so_doc_no)
  WHERE converted_from_so_doc_no IS NOT NULL;

ALTER TABLE scm.acc_credit_notes
  ADD COLUMN IF NOT EXISTS converted_payment_id uuid NULL;

CREATE INDEX IF NOT EXISTS acc_credit_notes_converted_payment_idx
  ON scm.acc_credit_notes (converted_payment_id)
  WHERE converted_payment_id IS NOT NULL;

COMMENT ON COLUMN scm.mfg_sales_order_payments.converted_from_so_doc_no IS
  'A converted payment (method converted): the cancelled order this row moved money from. NULL on money received.';
COMMENT ON COLUMN scm.acc_credit_notes.converted_payment_id IS
  'The converted payment row whose move this note took off a deposit invoice — a partial taker beside refund_pv_id.';
