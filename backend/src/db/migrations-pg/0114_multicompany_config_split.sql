-- 0114: make the last shared config tables PER-COMPANY (owner 2026-07-15 "分").
--
-- Rule: only Service + Delivery(TMS) are shared; everything else per-company.
--
-- SCOPE NOTE (verified on prod anogrigyjbduyzclzjgn via staging-first check):
--   * delivery_fee_config + fabric_tier_addon_config are ALREADY per-company in
--     the DATA (company_id added by 0083; prod already has a company-2 row at
--     id=100001 alongside company-1's id=1). The ONLY leak was the ROUTES reading
--     the singleton by `.eq('id',1)` unscoped. So those need NO migration — just
--     route changes to read/write by company_id (see delivery-fees.ts /
--     fabric-tier-addon.ts). Rekeying + seeding here would DUPLICATE the co-2 row
--     and shadow 2990's real config, so it is deliberately NOT done.
--   * sofa_combo_anchor does NOT exist on prod or staging (to_regclass = null) —
--     no migration needed; the route scoping is a harmless no-op until/if the
--     table is ever created.
--
-- So this migration handles ONLY the two tables that genuinely lack company_id:
--   1) mrp_category_lead_times — add company_id (backfill → HOUZS) + rekey the
--      unique to (company_id, warehouse_id, category) NULLS NOT DISTINCT + seed
--      the 2990 global-default bucket (5 categories @ 0).
--   2) so_settings — add company_id (backfill → HOUZS) + rekey PK key ->
--      (company_id, key) + seed 2990 a copy of the toggle set.
--
-- One-line DO blocks (runner splits on ';\n'); guarded by pg_class relkind so an
-- absent table is skipped, and by a non-null HOUZS id so a pre-companies deploy
-- no-ops. Idempotent. STAGING-VALIDATED 2026-07-15 (both blocks applied clean:
-- mrp co1=5/co2=5, so_settings co1=1/co2=1).

-- 1) mrp_category_lead_times — add company_id + rekey uniq(warehouse_id,category) -> (company_id,warehouse_id,category) NULLS NOT DISTINCT + seed 2990 global bucket (5 cats @ 0)
DO $$ DECLARE hid bigint; tid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='mrp_category_lead_times' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code='HOUZS'; SELECT id INTO tid FROM public.companies WHERE code='2990'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE scm.mrp_category_lead_times ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE scm.mrp_category_lead_times SET company_id=%s WHERE company_id IS NULL', hid); ALTER TABLE scm.mrp_category_lead_times ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.mrp_category_lead_times DROP CONSTRAINT IF EXISTS mrp_category_lead_times_company_id_fkey; ALTER TABLE scm.mrp_category_lead_times ADD CONSTRAINT mrp_category_lead_times_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); DROP INDEX IF EXISTS scm.mrp_category_lead_times_wh_cat_uniq; CREATE UNIQUE INDEX IF NOT EXISTS mrp_category_lead_times_co_wh_cat_uniq ON scm.mrp_category_lead_times (company_id, warehouse_id, category) NULLS NOT DISTINCT; IF tid IS NOT NULL THEN INSERT INTO scm.mrp_category_lead_times (company_id, warehouse_id, category, lead_days) SELECT tid, NULL::uuid, unnest(ARRAY['sofa','bedframe','mattress','accessory','service']), 0 ON CONFLICT DO NOTHING; END IF; END IF; END $$;

-- 2) so_settings — add company_id + rekey PK key -> (company_id,key) + seed 2990 copy of toggle set
DO $$ DECLARE hid bigint; tid bigint; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='so_settings' AND c.relkind IN ('r','p')) THEN SELECT id INTO hid FROM public.companies WHERE code='HOUZS'; SELECT id INTO tid FROM public.companies WHERE code='2990'; IF hid IS NULL THEN RETURN; END IF; ALTER TABLE scm.so_settings ADD COLUMN IF NOT EXISTS company_id bigint; EXECUTE format('UPDATE scm.so_settings SET company_id=%s WHERE company_id IS NULL', hid); ALTER TABLE scm.so_settings ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.so_settings DROP CONSTRAINT IF EXISTS so_settings_company_id_fkey; ALTER TABLE scm.so_settings ADD CONSTRAINT so_settings_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); ALTER TABLE scm.so_settings DROP CONSTRAINT IF EXISTS so_settings_pkey; ALTER TABLE scm.so_settings ADD PRIMARY KEY (company_id, key); IF tid IS NOT NULL THEN INSERT INTO scm.so_settings (company_id, key, enabled, label) SELECT tid, key, enabled, label FROM scm.so_settings WHERE company_id=hid ON CONFLICT DO NOTHING; END IF; END IF; END $$;
