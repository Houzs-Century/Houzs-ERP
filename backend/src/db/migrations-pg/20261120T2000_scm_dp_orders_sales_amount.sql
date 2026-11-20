-- 20261120T2000_scm_dp_orders_sales_amount.sql
-- A delivery raised in Delivery Planning with no sales order ("Delivery (no SO)",
-- owner 2026-11-20) carries its own sales amount, so the driver's Delivery
-- commission in Trip Pay is worked out on it (owner: 也要可以填 sales amount
-- 要不然 comm 算不到).
--
-- WHY. Trip Pay's commission is a % of a delivery's Local Total, read from the
-- delivery order. A delivery with no SO has no DO, so its amount was 0 and so was
-- the commission. This column holds the amount the operator types on the DP job;
-- Trip Pay reads it when the stop has no DO. In sen, like every money column in
-- scm. Null = not given (every existing job, every non-delivery job).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.dp_orders DROP COLUMN IF EXISTS sales_amount_sen;

ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS sales_amount_sen bigint
  CHECK (sales_amount_sen IS NULL OR sales_amount_sen >= 0);
