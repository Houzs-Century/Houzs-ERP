-- 020_supplier_rating.sql
-- Adds a separate "supplier rating" channel on closed cases.
--
-- The existing assr_cases.satisfaction_rating is the *customer's* rating
-- of the case outcome. This new column captures *staff's* rating of the
-- supplier's performance on that case (1-5). Kept on the case row (not a
-- separate table) because it is one rating per case and only meaningful
-- when the case actually used a supplier.

ALTER TABLE assr_cases ADD COLUMN supplier_rating INTEGER;        -- 1-5, nullable
ALTER TABLE assr_cases ADD COLUMN supplier_rating_notes TEXT;
ALTER TABLE assr_cases ADD COLUMN supplier_rated_at TEXT;
ALTER TABLE assr_cases ADD COLUMN supplier_rated_by INTEGER;      -- users.id

CREATE INDEX IF NOT EXISTS idx_assr_supplier_rating
  ON assr_cases(supplier_id, supplier_rating);
