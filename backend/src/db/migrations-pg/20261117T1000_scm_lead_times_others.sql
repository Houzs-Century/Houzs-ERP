-- 20261117T1000_scm_lead_times_others.sql
-- Adds an 'others' lead-time category (2990-0063): a supplier of dining, carpet,
-- bedlines or a diffuser had no category to set a lead time on. The resolver
-- (scm/lib/lead-time.ts) reads any item_group outside the five as 'others'.
-- Widen-only: every row that passed still passes. No row is written, so lead
-- days stay 0 for those groups until someone sets Others.
--
-- The base table's CHECK predates these migrations and its name is not on
-- record, so each table drops whatever CHECK mentions category (one line, as
-- pg-migrate splits on ";\n") and adds a named one.
--
-- REVERSAL (only once no 'others' row exists in either table):
--   ALTER TABLE scm.mrp_category_lead_times DROP CONSTRAINT mrp_category_lead_times_category_check;
--   ALTER TABLE scm.mrp_category_lead_times ADD CONSTRAINT mrp_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service'));
--   ALTER TABLE scm.mrp_supplier_category_lead_times DROP CONSTRAINT mrp_supplier_category_lead_times_category_check;
--   ALTER TABLE scm.mrp_supplier_category_lead_times ADD CONSTRAINT mrp_supplier_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service'));

DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.conrelid::regclass AS tbl, c.conname FROM pg_constraint c WHERE c.contype = 'c' AND c.conrelid IN ('scm.mrp_category_lead_times'::regclass, 'scm.mrp_supplier_category_lead_times'::regclass) AND pg_get_constraintdef(c.oid) LIKE '%category%' LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname); END LOOP; END $$;

ALTER TABLE scm.mrp_category_lead_times ADD CONSTRAINT mrp_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service', 'others'));

ALTER TABLE scm.mrp_supplier_category_lead_times ADD CONSTRAINT mrp_supplier_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service', 'others'));
