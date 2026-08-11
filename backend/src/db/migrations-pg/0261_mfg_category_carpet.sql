-- 0261_mfg_category_carpet.sql
-- Add 'CARPET' to the public.mfg_product_category enum so Houzs SKUs from the
-- AutoCount catalogue can be tagged. ALTER TYPE ... ADD VALUE only -- kept ALONE
-- in its own file (pg-migrate applies each file in its own transaction; ADD
-- VALUE IF NOT EXISTS is a safe no-op on replay and is not USED in this txn).
-- Guarded so a schema lacking the type is skipped rather than raising.

SET search_path = public;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname='mfg_product_category') THEN ALTER TYPE public.mfg_product_category ADD VALUE IF NOT EXISTS 'CARPET'; END IF; END $$;
