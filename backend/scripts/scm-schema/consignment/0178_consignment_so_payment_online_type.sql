-- 0178_consignment_so_payment_online_type.sql
-- Backfill a column OMITTED from 0153_consignment_module.sql.
--
-- 0153 created `consignment_sales_order_payments` as a "clone of
-- mfg_sales_order_payments" but dropped the `online_type` column — it was kept
-- only on the DO-side clone `consignment_delivery_order_payments` (0153 L380).
-- Meanwhile consignment-orders.ts reads AND writes online_type on the SO-side
-- table (PAYMENT_COLS select ~L1814 + INSERT ~L1867 + the method roll-up read
-- ~L283), so CREATING or LISTING a consignment SO payment 500'd on the missing
-- column ("column online_type does not exist"). Add it to match the DO-side
-- definition (text, nullable).
--
-- Found during a phantom-column audit and APPLIED to prod 2026-06-18 directly
-- in the Supabase SQL Editor. Additive + idempotent (the deploy auto-runner is
-- non-functional — stale DB password — so 2990s migrations are applied by hand).
ALTER TABLE consignment_sales_order_payments
  ADD COLUMN IF NOT EXISTS online_type text;
