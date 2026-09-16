-- 20260916T1200_so_payment_mirrors.sql
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.mfg_sales_order_payments_refund_pv_idx;
--   DROP INDEX IF EXISTS scm.mfg_sales_order_payments_mirror_of_idx;
--   ALTER TABLE scm.mfg_sales_order_payments DROP COLUMN IF EXISTS refund_pv_id;
--   ALTER TABLE scm.mfg_sales_order_payments DROP COLUMN IF EXISTS mirror_of_payment_id;
--   ALTER TABLE scm.mfg_sales_order_payments DROP COLUMN IF EXISTS converted_to_so_doc_no;
--   Dropping the three columns loses ONLY the link from a mirror row (a
--   negative `converted` row on the order the money left) to the converted
--   row or refund voucher it follows; the mirror rows themselves stay, as do
--   the converted rows, the vouchers and every journal. Delete the mirror rows
--   first (WHERE amount_sen < 0 AND method = 'converted') if the totals are
--   to read as before this landed. GRANTS: none touched.
--
-- WHAT THIS IS FOR (owner 2026-09-16). Refund and Convert stop being for
-- cancelled orders only: money may leave a LIVE order too (convert while the
-- order keeps at least its deposit fraction of the total; refund at Finance's
-- discretion). A live order has a balance, and every reader of an order's
-- money sums its payment rows — the totals view, the deposit gate, the lists,
-- AutoCount's balance, the invoice roll. So the money that LEFT is a payment
-- row as well: method `converted`, a NEGATIVE amount, on the order it left,
-- following the row or voucher that took it:
--
--   converted_to_so_doc_no   the order the money moved to
--   mirror_of_payment_id     the converted row on that order (written when it
--                            is booked, removed when it is deleted)
--   refund_pv_id             the posted Customer Refund voucher (written when
--                            it posts, removed when it is cancelled)
--
-- A mirror books nothing: the transfer or the voucher is the accounting. The
-- pool an order may still refund or move (lib/so-money.ts) reads booked money
-- off the ledger and never counts one.
--
-- ADDITIVE. Nothing is backfilled: conversions and refunds made before this
-- landed came off CANCELLED orders, whose balance is not due; their totals
-- stay as they read today.
--
-- Verified against: the Staging Migrations workflow on this branch (staging
-- minnapsemfzjmtvnnvdd) — run named in the PR body.

SET search_path = scm, public;

ALTER TABLE scm.mfg_sales_order_payments
  ADD COLUMN IF NOT EXISTS converted_to_so_doc_no text NULL,
  ADD COLUMN IF NOT EXISTS mirror_of_payment_id uuid NULL,
  ADD COLUMN IF NOT EXISTS refund_pv_id uuid NULL;

CREATE INDEX IF NOT EXISTS mfg_sales_order_payments_mirror_of_idx
  ON scm.mfg_sales_order_payments (company_id, mirror_of_payment_id)
  WHERE mirror_of_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mfg_sales_order_payments_refund_pv_idx
  ON scm.mfg_sales_order_payments (company_id, refund_pv_id)
  WHERE refund_pv_id IS NOT NULL;
