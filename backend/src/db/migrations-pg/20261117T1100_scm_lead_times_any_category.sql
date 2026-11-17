-- 20261117T1100_scm_lead_times_any_category.sql
-- Lead times for every product category, new ones included (2990-0063 follow-up).
-- Until now both lead-time tables only accepted a fixed list (sofa, bedframe,
-- mattress, accessory, service, others), so a category added in Products had no
-- row to set. The list now comes from the catalogue at run time
-- (scm/lib/lead-time.ts loadLeadCategoryOptions), and the routes refuse any
-- category not on it. The CHECK keeps only the shape: a lower-case item-group
-- code, the same shape scm.acc_register_item_group allows, lower-cased.
-- Widen-only: every row that passed still passes. No row is written.
--
-- REVERSAL: (only while no row outside the six exists in either table)
--   ALTER TABLE scm.mrp_category_lead_times DROP CONSTRAINT mrp_category_lead_times_category_check;
--   ALTER TABLE scm.mrp_category_lead_times ADD CONSTRAINT mrp_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service', 'others'));
--   ALTER TABLE scm.mrp_supplier_category_lead_times DROP CONSTRAINT mrp_supplier_category_lead_times_category_check;
--   ALTER TABLE scm.mrp_supplier_category_lead_times ADD CONSTRAINT mrp_supplier_category_lead_times_category_check CHECK (category IN ('sofa', 'bedframe', 'mattress', 'accessory', 'service', 'others'));

ALTER TABLE scm.mrp_category_lead_times DROP CONSTRAINT IF EXISTS mrp_category_lead_times_category_check;

ALTER TABLE scm.mrp_category_lead_times ADD CONSTRAINT mrp_category_lead_times_category_check CHECK (category ~ '^[a-z][a-z0-9_]{1,29}$');

ALTER TABLE scm.mrp_supplier_category_lead_times DROP CONSTRAINT IF EXISTS mrp_supplier_category_lead_times_category_check;

ALTER TABLE scm.mrp_supplier_category_lead_times ADD CONSTRAINT mrp_supplier_category_lead_times_category_check CHECK (category ~ '^[a-z][a-z0-9_]{1,29}$');
