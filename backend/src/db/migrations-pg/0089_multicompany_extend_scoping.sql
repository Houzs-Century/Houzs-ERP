-- 0089_multicompany_extend_scoping.sql — extend the multi-company company_id
-- stamp (migration 0083) to the per-company CONFIG / CATALOG scm tables that
-- 0083 left unscoped. Without this, importing the second company (2990) would
-- mix both companies' catalogs (fabrics, SO picklists, showrooms, racks, HR
-- config, ...) in shared pools.
--
-- Pattern is EXACTLY 0083's: one single-line DO block per table, guarded by a
-- pg_class relkind IN ('r','p') check (views + absent tables are SKIPPED, so
-- the file is safe on any of prod / staging / a fresh DB), then:
--   add col -> backfill existing rows to the HOUZS company -> NOT NULL ->
--   FK public.companies -> index.
-- All existing rows are Houzs's today, so the backfill is unconditional.
--
-- Tables stamped here (16):
--   product/config catalogs: fabrics, bedframe_colours, bedframe_options,
--     size_library, categories, fabric_colours, fabric_library,
--     compartment_library, warehouse_racks, so_dropdown_options, app_config,
--     venues, showrooms
--   hr/config: hr_commission_config, hr_item_kpi, hr_salesperson_profiles
--     (no Houzs routes read these yet — stamped for schema parity with 2990;
--      the relkind guard makes each a no-op where the table doesn't exist)
--
-- Deliberately NOT stamped (shared / per-staff reference data):
--   staff, currencies, my_localities, pos_carts, sofa_personal_quick_picks
--
-- UNIQUE-key conversions (mirrors 0087_master_codes_per_company): single-company
-- unique keys become UNIQUE(company_id, ...) so 2990 + Houzs can each hold the
-- same code/value. The old constraint/index name on this DB is not guaranteed
-- (the scm schema predates the migration ledger), so each conversion block
-- DYNAMICALLY drops any unique constraint/index on exactly the old column set
-- before adding the composite:
--   fabrics(code)                    -> UNIQUE(company_id, code)
--   showrooms(showroom_code)         -> UNIQUE(company_id, showroom_code)
--   so_dropdown_options(category, value) -> UNIQUE(company_id, category, value)
--   hr_salesperson_profiles(staff_id)    -> UNIQUE(company_id, staff_id)
-- NOT converted (documented):
--   warehouse_racks UNIQUE(warehouse_id, rack) — warehouse_id is already
--     company-bound (0086), so the key can't collide across companies.
--   categories / size_library / compartment_library / fabric_library /
--     bedframe_colours / bedframe_options — TEXT primary keys (the id IS the
--     code); a PK can't gain company_id without a PK redesign, so a 2990 import
--     must use ids distinct from Houzs's. Same for fabric_colours' composite
--     PK (fabric_id, colour_id) and app_config's key PK.
--   hr_commission_config — singleton PK (id=1 CHECK); stamped for provenance
--     only, a per-company config needs a PK redesign first.
--
-- ADDITIVE + idempotent + re-run-safe. Houzs CI auto-applies migrations-pg on
-- deploy (runner splits on ';\n' — every DO block stays on ONE line).

-- 1) company_id stamp -------------------------------------------------------

-- scm.fabrics
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='fabrics' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.fabrics ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.fabrics SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.fabrics ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.fabrics DROP CONSTRAINT IF EXISTS fabrics_company_id_fkey; ALTER TABLE scm.fabrics ADD CONSTRAINT fabrics_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_fabrics_company_id ON scm.fabrics (company_id); END IF; END $$;

-- scm.bedframe_colours
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='bedframe_colours' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.bedframe_colours ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.bedframe_colours SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.bedframe_colours ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.bedframe_colours DROP CONSTRAINT IF EXISTS bedframe_colours_company_id_fkey; ALTER TABLE scm.bedframe_colours ADD CONSTRAINT bedframe_colours_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_bedframe_colours_company_id ON scm.bedframe_colours (company_id); END IF; END $$;

-- scm.bedframe_options
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='bedframe_options' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.bedframe_options ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.bedframe_options SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.bedframe_options ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.bedframe_options DROP CONSTRAINT IF EXISTS bedframe_options_company_id_fkey; ALTER TABLE scm.bedframe_options ADD CONSTRAINT bedframe_options_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_bedframe_options_company_id ON scm.bedframe_options (company_id); END IF; END $$;

-- scm.size_library
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='size_library' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.size_library ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.size_library SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.size_library ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.size_library DROP CONSTRAINT IF EXISTS size_library_company_id_fkey; ALTER TABLE scm.size_library ADD CONSTRAINT size_library_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_size_library_company_id ON scm.size_library (company_id); END IF; END $$;

-- scm.categories
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='categories' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.categories ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.categories SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.categories ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.categories DROP CONSTRAINT IF EXISTS categories_company_id_fkey; ALTER TABLE scm.categories ADD CONSTRAINT categories_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_categories_company_id ON scm.categories (company_id); END IF; END $$;

-- scm.fabric_colours
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='fabric_colours' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.fabric_colours ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.fabric_colours SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.fabric_colours ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.fabric_colours DROP CONSTRAINT IF EXISTS fabric_colours_company_id_fkey; ALTER TABLE scm.fabric_colours ADD CONSTRAINT fabric_colours_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_fabric_colours_company_id ON scm.fabric_colours (company_id); END IF; END $$;

-- scm.fabric_library
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='fabric_library' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.fabric_library ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.fabric_library SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.fabric_library ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.fabric_library DROP CONSTRAINT IF EXISTS fabric_library_company_id_fkey; ALTER TABLE scm.fabric_library ADD CONSTRAINT fabric_library_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_fabric_library_company_id ON scm.fabric_library (company_id); END IF; END $$;

-- scm.compartment_library
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='compartment_library' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.compartment_library ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.compartment_library SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.compartment_library ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.compartment_library DROP CONSTRAINT IF EXISTS compartment_library_company_id_fkey; ALTER TABLE scm.compartment_library ADD CONSTRAINT compartment_library_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_compartment_library_company_id ON scm.compartment_library (company_id); END IF; END $$;

-- scm.warehouse_racks (rack_items + rack_movements were stamped by 0083; the
-- racks master itself was missed)
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='warehouse_racks' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.warehouse_racks ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.warehouse_racks SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.warehouse_racks ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.warehouse_racks DROP CONSTRAINT IF EXISTS warehouse_racks_company_id_fkey; ALTER TABLE scm.warehouse_racks ADD CONSTRAINT warehouse_racks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_warehouse_racks_company_id ON scm.warehouse_racks (company_id); END IF; END $$;

-- scm.so_dropdown_options
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='so_dropdown_options' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.so_dropdown_options ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.so_dropdown_options SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.so_dropdown_options ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.so_dropdown_options DROP CONSTRAINT IF EXISTS so_dropdown_options_company_id_fkey; ALTER TABLE scm.so_dropdown_options ADD CONSTRAINT so_dropdown_options_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_so_dropdown_options_company_id ON scm.so_dropdown_options (company_id); END IF; END $$;

-- scm.app_config
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='app_config' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.app_config ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.app_config SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.app_config ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.app_config DROP CONSTRAINT IF EXISTS app_config_company_id_fkey; ALTER TABLE scm.app_config ADD CONSTRAINT app_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_app_config_company_id ON scm.app_config (company_id); END IF; END $$;

-- scm.venues
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='venues' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.venues ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.venues SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.venues ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.venues DROP CONSTRAINT IF EXISTS venues_company_id_fkey; ALTER TABLE scm.venues ADD CONSTRAINT venues_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_venues_company_id ON scm.venues (company_id); END IF; END $$;

-- scm.showrooms
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='showrooms' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.showrooms ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.showrooms SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.showrooms ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.showrooms DROP CONSTRAINT IF EXISTS showrooms_company_id_fkey; ALTER TABLE scm.showrooms ADD CONSTRAINT showrooms_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_showrooms_company_id ON scm.showrooms (company_id); END IF; END $$;

-- scm.hr_commission_config
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_commission_config' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_commission_config SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.hr_commission_config ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.hr_commission_config DROP CONSTRAINT IF EXISTS hr_commission_config_company_id_fkey; ALTER TABLE scm.hr_commission_config ADD CONSTRAINT hr_commission_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_commission_config_company_id ON scm.hr_commission_config (company_id); END IF; END $$;

-- scm.hr_item_kpi
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_item_kpi' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_item_kpi ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_item_kpi SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.hr_item_kpi ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.hr_item_kpi DROP CONSTRAINT IF EXISTS hr_item_kpi_company_id_fkey; ALTER TABLE scm.hr_item_kpi ADD CONSTRAINT hr_item_kpi_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_item_kpi_company_id ON scm.hr_item_kpi (company_id); END IF; END $$;

-- scm.hr_salesperson_profiles
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_salesperson_profiles' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_salesperson_profiles ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_salesperson_profiles SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.hr_salesperson_profiles ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.hr_salesperson_profiles DROP CONSTRAINT IF EXISTS hr_salesperson_profiles_company_id_fkey; ALTER TABLE scm.hr_salesperson_profiles ADD CONSTRAINT hr_salesperson_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_salesperson_profiles_company_id ON scm.hr_salesperson_profiles (company_id); END IF; END $$;

-- 2) single-company UNIQUE keys -> UNIQUE(company_id, ...) -------------------
-- Each block: (a) guarded on table + company_id existing and the new composite
-- not existing yet; (b) drops ANY unique constraint/index on exactly the old
-- column set (name-agnostic — the scm schema predates the migration ledger, so
-- constraint names can't be assumed); (c) adds the named composite. One line
-- per block for the ';\n' splitter.

-- scm.fabrics: UNIQUE(code) -> UNIQUE(company_id, code)
DO $$ DECLARE r record; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='fabrics' AND c.relkind IN ('r','p')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='fabrics' AND column_name='company_id') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fabrics_company_code_unique') THEN FOR r IN SELECT ci.relname AS idxname, con.conname AS conname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND t.relname='fabrics' AND i.indisunique AND NOT i.indisprimary AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['code'] LOOP IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.fabrics DROP CONSTRAINT ' || quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.' || quote_ident(r.idxname); END IF; END LOOP; ALTER TABLE scm.fabrics ADD CONSTRAINT fabrics_company_code_unique UNIQUE (company_id, code); END IF; END $$;

-- scm.showrooms: UNIQUE(showroom_code) -> UNIQUE(company_id, showroom_code)
DO $$ DECLARE r record; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='showrooms' AND c.relkind IN ('r','p')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='showrooms' AND column_name='company_id') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='showrooms_company_code_unique') THEN FOR r IN SELECT ci.relname AS idxname, con.conname AS conname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND t.relname='showrooms' AND i.indisunique AND NOT i.indisprimary AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['showroom_code'] LOOP IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.showrooms DROP CONSTRAINT ' || quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.' || quote_ident(r.idxname); END IF; END LOOP; ALTER TABLE scm.showrooms ADD CONSTRAINT showrooms_company_code_unique UNIQUE (company_id, showroom_code); END IF; END $$;

-- scm.so_dropdown_options: UNIQUE(category, value) -> UNIQUE(company_id, category, value)
DO $$ DECLARE r record; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='so_dropdown_options' AND c.relkind IN ('r','p')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='so_dropdown_options' AND column_name='company_id') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='so_dropdown_options_company_category_value_unique') THEN FOR r IN SELECT ci.relname AS idxname, con.conname AS conname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND t.relname='so_dropdown_options' AND i.indisunique AND NOT i.indisprimary AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['category','value'] LOOP IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.so_dropdown_options DROP CONSTRAINT ' || quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.' || quote_ident(r.idxname); END IF; END LOOP; ALTER TABLE scm.so_dropdown_options ADD CONSTRAINT so_dropdown_options_company_category_value_unique UNIQUE (company_id, category, value); END IF; END $$;

-- scm.hr_salesperson_profiles: UNIQUE(staff_id) -> UNIQUE(company_id, staff_id)
-- (staff is a SHARED master — one staff can hold one HR profile per company)
DO $$ DECLARE r record; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_salesperson_profiles' AND c.relkind IN ('r','p')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='hr_salesperson_profiles' AND column_name='company_id') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hr_salesperson_profiles_company_staff_unique') THEN FOR r IN SELECT ci.relname AS idxname, con.conname AS conname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND t.relname='hr_salesperson_profiles' AND i.indisunique AND NOT i.indisprimary AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['staff_id'] LOOP IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.hr_salesperson_profiles DROP CONSTRAINT ' || quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.' || quote_ident(r.idxname); END IF; END LOOP; ALTER TABLE scm.hr_salesperson_profiles ADD CONSTRAINT hr_salesperson_profiles_company_staff_unique UNIQUE (company_id, staff_id); END IF; END $$;
