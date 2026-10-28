-- 0287 — key the compartment fabric-tier override (compartment_id, company_id).
--
-- REVERSAL: ALTER TABLE scm.compartment_fabric_tier_overrides DROP CONSTRAINT compartment_fabric_tier_overrides_pkey;
--           ALTER TABLE scm.compartment_fabric_tier_overrides ADD CONSTRAINT compartment_fabric_tier_overrides_pkey PRIMARY KEY (compartment_id);
--           ALTER TABLE scm.compartment_fabric_tier_overrides ALTER COLUMN company_id DROP NOT NULL;
--           PARTIAL, same shape as 0289: the single-column key only takes the
--           rows back while no compartment_id is held by both companies, which
--           is precisely what this migration makes possible.
--
-- THE SAME DEFECT AS 0284, in a table that moves MONEY. Mig 0025 created
-- scm.compartment_fabric_tier_overrides keyed `compartment_id text PRIMARY KEY`
-- (0025:11). Mig 0083 then added company_id to it — one of the 116 tables that
-- pass stamped — and left the KEY alone. A column was added; the key was not.
--
-- WHY THIS ONE CAN ACTUALLY COLLIDE, and its model-level twin cannot.
--
-- CORRECTED 2026-08-13, same day, by a doc-vs-source sweep. This header first
-- said "scm.compartment_library carries NO company_id, the catalogue is SHARED".
-- That is FALSE: mig 0089:74 adds company_id to it, NOT NULL, with an FK and an
-- index. The conclusion survives; the stated reason did not, and a migration
-- header that argues from a false premise is exactly the kind of lie this
-- repository keeps having to dig out of its own docs.
--
-- THE REAL REASON, traced rather than assumed: `compartment_id` here is an
-- UNVALIDATED FREE STRING. The route takes it straight from the request body
-- (routes/fabric-tier-addon.ts, compartmentSpecialSchema) and never joins it to
-- the catalogue — indeed NOTHING in backend/src reads scm.compartment_library at
-- all; it survives only in seed migrations. The values that actually arrive are
-- normalized sofa MODULE CODES (`normalizeCompartmentCode(moduleCodeFromSku(...))`,
-- shared/sofa-build.ts), and both companies independently produce codes from
-- their own SKUs, so the same string reaches this table from both.
--
-- So the contradiction is INSIDE THE ROUTE, not in a parent table: the GET filters
-- by company (its author believed these rows are per-company) while the PK
-- permitted exactly one row globally. That is provable from one file and needs no
-- assumption about the catalogue.
--
-- The twin table model_fabric_tier_overrides is keyed on model_id, and
-- product_models DOES carry company_id — each company owns its own model rows
-- with their own uuids, so two companies can never contend for one key there.
-- Same DDL shape, opposite verdict.
--
-- WHAT IT DOES TODAY. routes/fabric-tier-addon.ts:
--
--   GET  /compartment-special  -> scopeToCompany(...)                 per-company
--   PUT  /compartment-special  -> upsert(..., { onConflict: 'compartment_id' })
--
-- so when 2990 sets a delta on a compartment Houzs has already tuned, the upsert
-- lands on HOUZS'S ROW: deltas replaced, company_id flipped to 2990. Houzs's next
-- GET is scoped to Houzs, finds nothing, and shows the compartment as un-tagged.
-- The override did not fail to save — it was taken.
--
-- And a fabric-tier delta is a PRICE. mfg-pricing-recompute.ts:997 reads this
-- table when it re-derives a sofa line, so a lost override does not merely look
-- wrong on a config screen; it quietly reprices the build.
--
-- THIS IS NOT A BUSINESS QUESTION, which is why it is fixed rather than asked.
-- The two halves of the same file already disagree: the GET filters by company
-- (so its author believed these rows are per-company) while the PK permits one
-- row globally. Somebody deliberately added company_id and deliberately scoped
-- the read. The key is the leftover, exactly as it was for the POS cart.
--
-- THE FIX is the key, not more scoping. No route-side predicate can create a
-- second row when the PK forbids one.
--
-- ORDER MATTERS: backfill -> NOT NULL -> swap the key. PK columns must be NOT
-- NULL, and 0083 added company_id NULLABLE-then-NOT-NULL per table; this repeats
-- the backfill rather than trusting it, because a row inserted between the two
-- migrations by a code path that omitted the stamp would otherwise fail step 3.
--
-- SAFE ON DUPLICATES: the old PK guarantees at most one row per compartment_id,
-- so (compartment_id, company_id) cannot collide when it is created. A widening,
-- never a narrowing.
--
-- WHAT IT DOES NOT DO: it does not recover the overrides already overwritten.
-- Those rows are gone — the upsert replaced them in place, and nothing recorded
-- the previous values. Whoever tuned a compartment and found it blank later has
-- to set it again, once, after this lands.
--
-- ADDITIVE + idempotent + re-run-safe. CI auto-applies migrations-pg on every
-- deploy and the runner splits on ';\n', so each guarded block stays on ONE line
-- (mirrors 0284, 0100 and 0089).

CREATE SCHEMA IF NOT EXISTS scm;

-- 1. Backfill legacy NULL company_id to HOUZS (same shape as mig 0083's backfill).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='compartment_fabric_tier_overrides' AND c.relkind IN ('r','p')) THEN UPDATE scm.compartment_fabric_tier_overrides SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; END IF; END $$;

-- 2. Any row still NULL means the companies master has no HOUZS row (a fresh DB
--    with no seed). Such a row cannot be keyed and cannot be read by the scoped
--    GET either — it is already invisible, so dropping it loses nothing that was
--    reachable.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='compartment_fabric_tier_overrides' AND c.relkind IN ('r','p')) THEN DELETE FROM scm.compartment_fabric_tier_overrides WHERE company_id IS NULL; END IF; END $$;

-- 3. NOT NULL, required before the column can join the primary key.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='compartment_fabric_tier_overrides' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.compartment_fabric_tier_overrides ALTER COLUMN company_id SET NOT NULL; END IF; END $$;

-- 4. Swap the key. Guarded on the CURRENT key still being the single-column one,
--    so a re-run (or a DB where this already landed) is a clean no-op.
DO $$ DECLARE pk_name text; pk_cols int; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='compartment_fabric_tier_overrides' AND c.relkind IN ('r','p')) THEN SELECT con.conname, array_length(con.conkey, 1) INTO pk_name, pk_cols FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'scm' AND c.relname = 'compartment_fabric_tier_overrides' AND con.contype = 'p'; IF pk_name IS NOT NULL AND pk_cols = 1 THEN EXECUTE format('ALTER TABLE scm.compartment_fabric_tier_overrides DROP CONSTRAINT %I', pk_name); END IF; IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'scm' AND c.relname = 'compartment_fabric_tier_overrides' AND con.contype = 'p') THEN ALTER TABLE scm.compartment_fabric_tier_overrides ADD CONSTRAINT compartment_fabric_tier_overrides_pkey PRIMARY KEY (compartment_id, company_id); END IF; END IF; END $$;

COMMENT ON TABLE scm.compartment_fabric_tier_overrides IS 'Per-compartment PRICE-2/PRICE-3 fabric-tier deltas, ONE ROW PER (compartment, company). Keyed (compartment_id, company_id) since mig 0287 - mig 0025 keyed it on compartment_id alone and mig 0083 added company_id without touching the key, so one company upserting a delta OVERWROTE the other company row and the loss was silent AND repriced sofa builds via mfg-pricing-recompute. compartment_id is an UNVALIDATED free string taken from the request body and never joined to scm.compartment_library (nothing in backend/src reads that table); the values are normalized sofa module codes, which both companies independently produce from their own SKUs. Read with scopeToCompany, written with onConflict compartment_id,company_id.';
