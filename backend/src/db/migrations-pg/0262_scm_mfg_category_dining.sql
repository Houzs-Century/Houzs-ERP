-- 0262_scm_mfg_category_dining.sql
-- The LIVE mfg_products.category column uses scm.mfg_product_category (created
-- out-of-band; the committed dump only shows the public one). Migrations
-- 0258-0261 added these values to public.mfg_product_category -- the WRONG
-- enum -- so inserting category 'DINING' failed. Add it to the scm enum too.
-- ALTER TYPE ... ADD VALUE only, alone in its own file, guarded, replay-safe.

SET search_path = scm, public;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='scm' AND t.typname='mfg_product_category') THEN ALTER TYPE scm.mfg_product_category ADD VALUE IF NOT EXISTS 'DINING'; END IF; END $$;
