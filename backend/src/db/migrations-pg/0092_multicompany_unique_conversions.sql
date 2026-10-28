-- 0092: finish per-company uniqueness for the last staging-audit gaps.
--
-- Staging import audit (2026-07-13) showed 12 source rows still skipped by
-- GLOBAL unique constraints on: addons, bundle_library,
-- delivery_planning_regions, maintenance_config_history,
-- special_addons_history — their PK collisions were solved by the import's
-- id-remap, but name/version-style UNIQUEs still collide across companies.
-- Plus state_warehouse_mappings (state -> warehouse per company) was never
-- company-scoped at all.
--
-- 1) state_warehouse_mappings gets company_id (0083 pattern).
-- 2) Generic conversion: for each listed table, every non-PK, non-partial,
--    plain-column UNIQUE that doesn't already include company_id is rebuilt as
--    UNIQUE(company_id, <same cols>). Idempotent: converted constraints
--    include company_id so a re-run skips them. Partial/expression indexes are
--    left untouched (none expected on these tables).
--
-- Deliberately left SHARED (documented decision, revisit if the companies
-- diverge): so_settings (singleton row, same seed) and
-- mrp_category_lead_times (global-default bucket keyed by NULL warehouse_id;
-- per-warehouse rows are already company-separated via warehouse uuids).

-- scm.state_warehouse_mappings: add company_id (0083 pattern)
DO $$ DECLARE hid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='state_warehouse_mappings' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code = 'HOUZS'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE scm.state_warehouse_mappings ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE scm.state_warehouse_mappings SET company_id = %s WHERE company_id IS NULL', hid); ALTER TABLE scm.state_warehouse_mappings ALTER COLUMN company_id SET NOT NULL; EXECUTE format('ALTER TABLE scm.state_warehouse_mappings ALTER COLUMN company_id SET DEFAULT %s', hid); ALTER TABLE scm.state_warehouse_mappings DROP CONSTRAINT IF EXISTS state_warehouse_mappings_company_id_fkey; ALTER TABLE scm.state_warehouse_mappings ADD CONSTRAINT state_warehouse_mappings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_state_warehouse_mappings_company_id ON scm.state_warehouse_mappings (company_id); END IF; END $$;

-- Generic UNIQUE -> UNIQUE(company_id, ...) conversion for the gap tables.
DO $$ DECLARE t text; r record; newname text; BEGIN FOREACH t IN ARRAY ARRAY['addons','bundle_library','delivery_planning_regions','maintenance_config_history','special_addons_history','state_warehouse_mappings'] LOOP IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=t AND column_name='company_id') THEN CONTINUE; END IF; FOR r IN SELECT ci.relname AS idxname, con.conname AS conname, (SELECT string_agg(quote_ident(a.attname), ',' ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = tb.oid AND a.attnum = k.attnum WHERE k.attnum > 0) AS collist FROM pg_index i JOIN pg_class tb ON tb.oid = i.indrelid JOIN pg_namespace n ON n.oid = tb.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND tb.relname = t AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL LOOP IF r.collist IS NULL OR position('company_id' in r.collist) > 0 THEN CONTINUE; END IF; IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.'||quote_ident(t)||' DROP CONSTRAINT '||quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.'||quote_ident(r.idxname); END IF; newname := left(t,40)||'_co_'||substr(md5(r.collist),1,8)||'_uq'; EXECUTE 'ALTER TABLE scm.'||quote_ident(t)||' ADD CONSTRAINT '||quote_ident(newname)||' UNIQUE (company_id,'||r.collist||')'; END LOOP; END LOOP; END $$;
