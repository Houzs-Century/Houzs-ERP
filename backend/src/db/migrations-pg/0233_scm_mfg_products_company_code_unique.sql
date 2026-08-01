-- 0233_scm_mfg_products_company_code_unique.sql
--
-- One SKU code, one product — PER COMPANY.
--
-- 2026-08-01: a POS order could not be placed. `pwp_code_rejected — CODY-(SS):
-- this SKU has no PWP price set (SKU Master)`, while the SKU Master showed
-- RM 490 for that exact SKU the whole time. Both statements were true of
-- DIFFERENT ROWS: `idx_mfg_products_code` is a plain btree, both companies keep
-- their own SKU master, and SEVENTEEN codes existed under both — CODY / FENRIR /
-- JAGER × (K)(Q)(S)(SK)(SS) plus two mattress codes — TWELVE of them disagreeing
-- on `pwp_price_sen`. Every company-scoped read (GET /mfg-products, the POS
-- catalogue) saw 2990's row; the SO pricing path, which had no company
-- predicate, could see HOUZS's.
--
-- The code fix in this PR is the load-bearing one: the pricing / allowed-options
-- / item-code loaders now resolve by (company_id, code). This index is the
-- guarantee that they resolve to ONE row — `.maybeSingle()` on that pair is now
-- single by construction rather than by luck — and it stops a future import from
-- quietly seeding a same-company twin, which is the shape that would break the
-- fix again.
--
-- NOT a global UNIQUE(code): the collisions are legitimate. HOUZS manufactures a
-- CODY bedframe and 2990 sells one; neither row can be renamed, and both must
-- keep the name their operators use. The uniqueness that was always intended is
-- per-company — 0187's own header states the natural key is
-- (company_id, product_code); this makes the database agree.
--
-- SAFE TO APPLY AS-IS: the production probe (workflow "Diag PWP price gap",
-- run 30687371204, read-only) reported 0 within-company duplicates. If that has
-- changed since, this migration FAILS LOUDLY rather than picking a survivor —
-- which is correct: two rows for one code in one company is a data question with
-- a money answer, not something a migration should decide.
--
-- HOUSE STYLE: no runtime self-apply, IF NOT EXISTS throughout, SET search_path
-- so unqualified scm objects resolve.

SET search_path = public, scm;

-- The plain index stays: it still serves cross-company lookups (the diag
-- script's duplicate scan, the import reconcilers) and Postgres will use the
-- unique one for (company_id, code) probes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfg_products_company_code
  ON scm.mfg_products (company_id, code);

COMMENT ON INDEX scm.uq_mfg_products_company_code IS
  'One SKU code per company. `code` alone is NOT unique — both companies keep their own SKU master and 17 codes collided on 2026-08-01, which mis-priced the SO path. Every by-code product read must pass company_id; see loadProductByCode / loadProductsByCodes in scm/lib/mfg-pricing-recompute.ts.';

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS scm.uq_mfg_products_company_code;
