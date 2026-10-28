-- 20260916T0300_scm_supplier_and_product_cost_history.sql
-- Effective-dated SUPPLIER cost + derived PRODUCT cost — the foundation for
-- auto-derive stage 3 (owner 2026-09-16: "effective date 也很重要").
--
-- Two append-only history tables, mirroring the sell-price history (0187) and
-- the maintenance_config_history / po-pricing resolver shape that already work
-- here (loadConfigForScope, resolveSellPriceSenAsOf):
--
--   supplier_binding_price_history — a supplier's cost for a SKU, scheduled by
--     effective_from with the prior value kept. The SOURCE the owner maintains.
--   mfg_product_cost_history — the DERIVED product cost (whole-set max supplier)
--     as of a date, so the SO recompute can read the correct BUDGET cost as-of
--     the order's date and historical figures don't move. The recompute (stage
--     3b) appends a row here when a supplier price change takes effect.
--
-- ADDITIVE + BACKWARD-COMPATIBLE: these only STORE scheduled/derived history.
-- The flat scm.supplier_material_bindings and scm.mfg_products columns stay the
-- live "current" values AND the fallbacks. With both tables empty every price
-- resolves exactly as today — zero behaviour change until a row exists, and even
-- then only when the scm.auto_derive_product_cost flag is ON. See
-- docs/pricing-effective-dating-design.md and
-- tasks/PLAN-auto-derive-product-price-from-supplier.md.
--
-- Per-company throughout: the same item_code exists under both companies.
-- Append-only: rows are immutable history; a correction is a new row.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.mfg_product_cost_history,
-- scm.supplier_binding_price_history; — both are additive and unread until
-- stage 3b/3c wire them, so dropping them restores today's behaviour exactly.
-- No grants to restore (no view).
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS throughout, SET search_path
-- so unqualified scm types resolve.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.supplier_binding_price_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       bigint NOT NULL,
  supplier_id      uuid   NOT NULL,
  material_kind    scm.material_kind NOT NULL,
  item_code        text   NOT NULL,
  -- The supplier's cost as of effective_from. Same shape as the flat binding:
  -- unit_price_sen (flat) and/or price_matrix (bedframe {P1,P2} / sofa
  -- {h:{P1,P2,P3}}). is_main_supplier is snapshotted so the derivation's
  -- tie-break can run against the as-of picture.
  unit_price_sen   integer,
  price_matrix     jsonb,
  is_main_supplier boolean NOT NULL DEFAULT false,
  effective_from   date   NOT NULL,
  notes            text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The resolver's exact lookup: newest effective_from <= asOf per supplier for a
-- (company, material, code), tie-broken by created_at.
CREATE INDEX IF NOT EXISTS idx_sbph_asof
  ON scm.supplier_binding_price_history
     (company_id, material_kind, item_code, supplier_id, effective_from DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS scm.mfg_product_cost_history (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         bigint NOT NULL,
  item_code          text   NOT NULL,
  -- The DERIVED cost as of effective_from (what a supplier-price change on that
  -- date produces). base_price_sen = PRICE_2/cost ref; price1_sen = PRICE_1;
  -- seat_height_prices = sofa per-(height,tier) grid. NULLs mean "no change to
  -- that lane" (the resolver falls back to the flat mfg_products value).
  base_price_sen     integer,
  price1_sen         integer,
  seat_height_prices jsonb,
  -- Which supplier's whole set was taken (provenance; not read by pricing).
  source_supplier_id uuid,
  effective_from     date   NOT NULL,
  notes              text,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mpch_asof
  ON scm.mfg_product_cost_history
     (company_id, item_code, effective_from DESC, created_at DESC);
