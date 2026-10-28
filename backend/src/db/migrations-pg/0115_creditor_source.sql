-- Manual supplier assignment (Nick 2026-07-14): when AutoCount has no
-- MainSupplier for a case's item, staff can hand-pick or register the
-- creditor. creditor_source records who owns the link:
--   'manual' — staff picked it; the auto-resolver and the bulk stock
--              refresh must leave it alone
--   'auto'   — derived from stock_items.main_supplier (may be re-pointed)
--   NULL     — legacy rows / unlinked
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS creditor_source text;
