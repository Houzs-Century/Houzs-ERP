-- 20261008T0946_scm_product_requests_supplier_price.sql
-- REVERSAL: ALTER TABLE scm.product_requests DROP COLUMN IF EXISTS unit_price_sen;
--   ALTER TABLE scm.product_requests DROP COLUMN IF EXISTS supplier_id;
--   Revert the code first (routes/product-requests.ts reads and writes both;
--   PurchaseConsignmentOrderNew.tsx seeds the order from them). Dropping them
--   loses the supplier and price a requester typed on open requests; the PC
--   Orders already raised keep their own supplier and price.
--   GRANTS: none to re-apply — a column rides its table's grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two nullable
-- columns on scm.product_requests. Every existing row reads NULL; no row is
-- written.
--
-- WHY (owner 2026-10-08, 方案 C for 2990: the Sales Director names the supplier
-- and the agreed price on the request; the Purchaser records it and raises the
-- PC Order without re-negotiating). Typed fields instead of remarks, so PC Order
-- New can seed the supplier and the line price from the request.

ALTER TABLE scm.product_requests
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES scm.suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_price_sen bigint CHECK (unit_price_sen IS NULL OR unit_price_sen >= 0);
CREATE INDEX IF NOT EXISTS idx_product_requests_supplier ON scm.product_requests (supplier_id) WHERE supplier_id IS NOT NULL;
