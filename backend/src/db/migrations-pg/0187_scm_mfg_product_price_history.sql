-- 0187_scm_mfg_product_price_history.sql — effective-dated PRODUCT SELLING price.
--
-- Owner 2026-07-24 ("我要B"): a product's selling price should be scheduled by
-- date (1/1=100, 3/1=200, 5/1=500) and a sales order should take the price that
-- was effective ON ITS OWN DATE. Today scm.mfg_products.sell_price_sen is a FLAT
-- column read with no date (mfg-pricing-recompute.ts). This adds an append-only
-- history alongside it — copied from the maintenance_config_history / po-pricing
-- resolver shape that already works here (see loadConfigForScope).
--
-- ADDITIVE + BACKWARD-COMPATIBLE: this table only STORES scheduled prices. The
-- flat sell_price_sen stays the live "current" value AND the fallback. With this
-- table empty, every price resolves exactly as before — no behaviour change until
-- a price is scheduled. See docs/pricing-effective-dating-design.md.
--
-- Per-company: the same product_code can exist under both companies as different
-- products, so the natural key is (company_id, product_code) — the key the SO
-- pricing path already resolves by (loadProductByCode). Append-only: rows are
-- immutable history; a correction is a new row, never an UPDATE.
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS throughout, SET search_path
-- so unqualified scm types resolve.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.mfg_product_price_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     bigint NOT NULL,
  product_code   text   NOT NULL,
  -- NULL = "this scheduled change does not move the selling price" (reserved for
  -- future multi-column snapshots; Phase 1 always writes it).
  sell_price_sen integer,
  effective_from date   NOT NULL,
  notes          text,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- The resolver's exact lookup: newest effective_from <= asOf for a
-- (company, code), tie-broken by created_at. This index serves both the
-- "current as-of" (DESC scan, limit 1) and the "next pending" (range) queries.
CREATE INDEX IF NOT EXISTS idx_mfg_price_hist_lookup
  ON scm.mfg_product_price_history (company_id, product_code, effective_from DESC, created_at DESC);
