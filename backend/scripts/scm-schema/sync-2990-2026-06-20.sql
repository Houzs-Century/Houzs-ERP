-- ============================================================================
-- SCM sync 2026-06-20 — port of 2990 migrations 0180 + 0181 into Houzs `scm`.
--
-- Supplier-revised delivery dates 2/3/4 (header + line) for both the normal
-- Purchase Order flow (0180) and the Purchase-Consignment Order flow (0181).
--
-- The supplier only ever pushes the delivery date BACK, so the EFFECTIVE
-- (latest committed) date a reader uses = MAX over the non-null of
-- [base date, _2, _3, _4]. That MAX is computed ONLY at read sites, via the
-- shared effectiveDelivery() helper (backend/src/scm/shared/effective-delivery.ts).
-- It is NOT flipped to MAX in storage — expected_at (header) and delivery_date
-- (line) keep their original "earliest" meaning.
--
-- All new columns are nullable, default NULL, additive + idempotent
-- (ADD COLUMN IF NOT EXISTS). No backfill.
--
-- DELIBERATELY OMITTED vs 2990's 0180:
--   * The `v_po_outstanding` view rebuild (GREATEST(...) AS effective_expected_at).
--     Houzs's scm schema has NO v_po_outstanding view (the 2990 export + the
--     Houzs scm-views apply script never created it), so there is nothing to
--     recreate here. If a PO-outstanding view is ever added to Houzs scm, add the
--     effective_expected_at = GREATEST(expected_at, _2, _3, _4) column then.
--
-- Tables live in the `scm` Postgres schema (Houzs re-targets 2990's public.* to
-- scm.* — see apply-scm-schema.mjs). This file is schema-qualified.
--
-- ⚠️ NOT APPLIED. Owner applies SCM migrations on prod (PROD DB access is
-- restricted from this environment). Apply BEFORE deploying the code that reads
-- these columns, or the live API 500s on the missing column. The new routes read
-- the columns with `r.camelCase ?? r.snake_case` dual-reads, but the SELECT lists
-- name the snake_case columns, so the columns must exist first.
-- ============================================================================

BEGIN;

-- ── 0180 — Purchase Order supplier delivery dates (header + line) ──────────
ALTER TABLE "scm"."purchase_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE "scm"."purchase_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE "scm"."purchase_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;

ALTER TABLE "scm"."purchase_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE "scm"."purchase_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE "scm"."purchase_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;

-- ── 0181 — Purchase-Consignment Order supplier delivery dates (header + line) ─
ALTER TABLE "scm"."purchase_consignment_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE "scm"."purchase_consignment_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE "scm"."purchase_consignment_orders"      ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;

ALTER TABLE "scm"."purchase_consignment_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_2 date;
ALTER TABLE "scm"."purchase_consignment_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_3 date;
ALTER TABLE "scm"."purchase_consignment_order_items" ADD COLUMN IF NOT EXISTS supplier_delivery_date_4 date;

COMMIT;
