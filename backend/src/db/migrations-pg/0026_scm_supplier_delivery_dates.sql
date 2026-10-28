-- 0026_scm_supplier_delivery_dates.sql — port of 2990 migrations 0180 + 0181.
-- Supplier-revised delivery dates 2/3/4 (header + line) for the Purchase Order
-- flow (0180) and the Purchase-Consignment Order flow (0181). The supplier only
-- ever pushes the date BACK, so the EFFECTIVE date a reader uses = MAX over the
-- non-null of [base, _2, _3, _4], computed ONLY at read sites via the shared
-- effectiveDelivery() helper (backend/src/scm/shared/effective-delivery.ts).
-- Storage keeps the original "earliest" meaning. All columns nullable, additive,
-- idempotent. Supersedes the un-applied scripts/scm-schema/sync-2990-2026-06-20.sql
-- (which the PC-order detail code already SELECTs by name — without these columns
-- the live API 500s, so this closes that latent gap).
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); each statement ends ';'+newline with no internal ';\n'.
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
ALTER TABLE scm.purchase_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_consignment_orders ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE scm.purchase_consignment_order_items ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;
