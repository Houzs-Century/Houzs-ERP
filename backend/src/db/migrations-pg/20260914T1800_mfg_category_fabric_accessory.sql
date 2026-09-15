-- 20260914T1800_mfg_category_fabric_accessory.sql
-- REVERSAL: IRREVERSIBLE - Postgres cannot drop a value from an enum type. To
--   withdraw the category, move every mfg_products row off 'FABRIC_ACCESSORY'
--   and remove it from MFG_PRODUCT_CATEGORIES / the frontend MfgCategory list;
--   the unused label then sits harmlessly in the type.
--
-- Add 'FABRIC_ACCESSORY' to public.mfg_product_category - the SOFA ACCESSORY
-- category (owner 2026-09-14): custom square / long pillows pick a fabric colour
-- from the fabric master like a sofa, their stock is keyed by that colour, and
-- MRP binds them per order. Shown to people as "Sofa Accessory".
--
-- The label carries no 'sofa' on purpose: 41 readers test a group with
-- includes('sofa') and would treat a pillow as a SOFA main product.
-- tasks/PLAN-sofa-accessories-category.md.
--
-- TWO TYPES, NOT ONE. The live catalogue holds BOTH public.mfg_product_category
-- AND scm.mfg_product_category, with identical labels, and columns in both
-- schemas are typed `mfg_product_category` (probe-category-constraints, run
-- 34834008369). The DINING precedent (0258) named only the public type. Adding
-- the value to one would let the category appear in the UI and then be refused
-- by whichever column is typed with the other, so both are extended. Each is
-- guarded and IF NOT EXISTS, so a schema lacking either is skipped and a replay
-- is a no-op.
--
-- ALTER TYPE ... ADD VALUE only, kept ALONE in its own file exactly like
-- 0258_mfg_category_dining.sql: pg-migrate applies each file in its own
-- transaction, and a value added in a transaction cannot be USED in it.

SET search_path = public;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='mfg_product_category') THEN ALTER TYPE public.mfg_product_category ADD VALUE IF NOT EXISTS 'FABRIC_ACCESSORY'; END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='scm' AND t.typname='mfg_product_category') THEN ALTER TYPE scm.mfg_product_category ADD VALUE IF NOT EXISTS 'FABRIC_ACCESSORY'; END IF; END $$;
