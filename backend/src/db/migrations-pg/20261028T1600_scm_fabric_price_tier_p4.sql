-- 20261028T1600_scm_fabric_price_tier_p4.sql
-- 2990-0024: sofa fabrics get a fourth price tier. Supplier lists (THL / Raffreka)
-- price every module at Fabric / Acacia / Half Leather / Full Leather, so a sofa
-- fabric may now be PRICE_3 (Half Leather) or PRICE_4 (Full Leather).
--
-- ALTER TYPE ... ADD VALUE only, alone in its own file: pg-migrate wraps each file
-- in one transaction and Postgres refuses to USE a value added in that same
-- transaction. Idempotent via IF NOT EXISTS.
--
-- REVERSAL: IRREVERSIBLE — Postgres cannot drop an enum value. To retire it,
--   move every row off PRICE_4 (fabric_trackings.*_price_tier,
--   sofa_combo_pricing.tier) and leave the label unused.

SET search_path = scm, public;

ALTER TYPE scm.fabric_price_tier ADD VALUE IF NOT EXISTS 'PRICE_4' AFTER 'PRICE_3';
