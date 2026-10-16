-- 20261006T1200_scm_po_line_delivery_date_overridden.sql
-- REVERSAL: ALTER TABLE scm.purchase_order_items DROP COLUMN IF EXISTS line_delivery_date_overridden;
--   Revert the code first: routes/mfg-purchase-orders.ts selects the column on
--   the PO detail, writes it on the line add / line PATCH, and the header
--   Delivery Date cascade skips lines where it is true. Dropping it loses which
--   line dates a user set by hand; the next header date change would then move
--   them.
--   GRANTS: none to re-apply — a column rides its table's grants.
--
-- WHAT THIS CHANGES: one new boolean column on scm.purchase_order_items,
--   NOT NULL DEFAULT false, the same name and type as
--   scm.consignment_sales_order_items.line_delivery_date_overridden. Every
--   existing line reads false (follows the header); no row is written by hand.
--
-- WHY (owner 2026-10-06): when the PO header Delivery Date changes, every line
-- follows, except a line whose date a user set by hand ("this is highest
-- rules") and a line already fully received. PO lines had no way to tell a
-- hand-set date apart, so this column records it, as the Consignment Order does.

ALTER TABLE scm.purchase_order_items
  ADD COLUMN IF NOT EXISTS line_delivery_date_overridden boolean NOT NULL DEFAULT false;
