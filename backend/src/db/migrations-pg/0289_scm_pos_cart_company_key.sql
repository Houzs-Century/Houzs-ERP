-- 0289_scm_pos_cart_company_key.sql — make the POS cart key (staff_id, company_id).
--
-- REVERSAL: ALTER TABLE scm.pos_carts DROP CONSTRAINT pos_carts_pkey;
--           ALTER TABLE scm.pos_carts ADD CONSTRAINT pos_carts_pkey PRIMARY KEY (staff_id);
--           ALTER TABLE scm.pos_carts ALTER COLUMN company_id DROP NOT NULL;
--           PARTIAL: the single-column key only accepts the rows back while no
--           staff id holds a cart in both companies - which is the very thing
--           this migration makes possible, so after either company has written
--           one, reversing needs a human decision about which cart survives.
--
-- THE BUG. scm.pos_carts was imported from 2990 keyed `staff_id uuid PRIMARY KEY`
-- (scripts/scm-schema/2990s-full-schema.sql:930). Migration 0100 then added
-- company_id so the merged backend could scope carts per company — its own header
-- says "carts must be company-scoped so the ported route can filter/stamp
-- company_id ... like every other per-company module" — but it left the PRIMARY
-- KEY alone. A column was added; the KEY was not. So the table still physically
-- holds ONE row per salesperson across ALL companies, while the route reads with
-- scopeToCompany and writes with `onConflict: 'staff_id'`.
--
-- What that does to a salesperson who works both companies:
--
--   1. In Houzs they build a cart          -> row {staff, lines: HOUZS, company_id: 1}
--   2. They switch to 2990; POS loads      -> GET is scoped to company 2, the row
--                                             says 1, so no match: EMPTY CART.
--                                             Looks correct, and it is.
--   3. They add one line and it saves      -> upsert onConflict 'staff_id' hits
--                                             THE SAME ROW: lines replaced with
--                                             the 2990 lines, company_id -> 2.
--   4. They switch back to Houzs           -> GET scoped to company 1 finds
--                                             nothing. THE HOUZS CART IS GONE.
--
-- No error, no warning, and the loss is indistinguishable from "I never saved it".
-- The feature exists precisely so a cart follows the salesperson (chairman
-- 2026-05-31, quoted in routes/pos-cart.ts) — instead, switching company destroys
-- it. Read the code, not the column: company_id being present is what makes this
-- look handled.
--
-- THE FIX is the key, not more scoping. No amount of route-side predicate can
-- create a second row when the PK forbids one.
--
-- ORDER MATTERS: backfill -> NOT NULL -> swap the key. PK columns must be NOT
-- NULL, and 0100 deliberately added company_id NULLABLE so it could never fail on
-- prod. Legacy NULL rows are backfilled to HOUZS, matching how mig 0083 backfilled
-- all 120 of its tables.
--
-- SAFE ON DUPLICATES: the old PK guarantees at most one row per staff_id, so
-- (staff_id, company_id) cannot collide when it is created. This is a widening,
-- never a narrowing.
--
-- COST OF THE NOT NULL, stated plainly: a save while the active company is
-- UNRESOLVED (companies master unreachable on a cold isolate) can no longer write
-- a NULL-company row. routes/pos-cart.ts refuses it with a plain-language 409
-- instead — the same fail-safe shape that file already uses for an unlinked staff
-- profile. A cart save that fails for a moment and says so is strictly better than
-- one that silently overwrites the other company's cart forever, and the client
-- retries on its next debounce.
--
-- ADDITIVE + idempotent + re-run-safe. Houzs CI auto-applies migrations-pg on
-- every deploy and the runner splits on ';\n', so each guarded block stays on ONE
-- line (mirrors 0100 and 0089).

CREATE SCHEMA IF NOT EXISTS scm;

-- 1. Backfill legacy NULL company_id to HOUZS (same shape as mig 0083's backfill).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='pos_carts' AND c.relkind IN ('r','p')) THEN UPDATE scm.pos_carts SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; END IF; END $$;

-- 2. Any row still NULL means the companies master has no HOUZS row (a fresh DB
--    with no seed). Deleting a live working cart is not acceptable, so drop only
--    the unusable rows: a cart with no company cannot be keyed and cannot be read
--    by the scoped GET either — it is already invisible, not data anyone can lose.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='pos_carts' AND c.relkind IN ('r','p')) THEN DELETE FROM scm.pos_carts WHERE company_id IS NULL; END IF; END $$;

-- 3. NOT NULL, required before the column can join the primary key.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='pos_carts' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.pos_carts ALTER COLUMN company_id SET NOT NULL; END IF; END $$;

-- 4. Swap the key. Guarded on the CURRENT key still being the single-column one,
--    so a re-run (or a DB where this already landed) is a clean no-op.
DO $$ DECLARE pk_name text; pk_cols int; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='pos_carts' AND c.relkind IN ('r','p')) THEN SELECT con.conname, array_length(con.conkey, 1) INTO pk_name, pk_cols FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'scm' AND c.relname = 'pos_carts' AND con.contype = 'p'; IF pk_name IS NOT NULL AND pk_cols = 1 THEN EXECUTE format('ALTER TABLE scm.pos_carts DROP CONSTRAINT %I', pk_name); END IF; IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'scm' AND c.relname = 'pos_carts' AND con.contype = 'p') THEN ALTER TABLE scm.pos_carts ADD CONSTRAINT pos_carts_pkey PRIMARY KEY (staff_id, company_id); END IF; END IF; END $$;

COMMENT ON TABLE scm.pos_carts IS 'The salesperson live in-progress POS cart, ONE PER (staff, company). Keyed (staff_id, company_id) since mig 0284 - it was keyed on staff_id alone from the 2990 import, so a company switch overwrote the other company cart and the loss was silent. Read with scopeToCompany, written with onConflict staff_id,company_id.';
