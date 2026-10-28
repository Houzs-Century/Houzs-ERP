-- 144_assr_product_categories_refresh.sql
-- D1 test mirror of migrations-pg/0254 (SQLite dialect).

UPDATE assr_product_categories SET name = 'Bedframe', sort_order = 10 WHERE slug = 'bed_frame';
UPDATE assr_product_categories SET sort_order = 20 WHERE slug = 'sofa';
UPDATE assr_product_categories SET sort_order = 30 WHERE slug = 'mattress';

INSERT INTO assr_product_categories (slug, name, sort_order) VALUES ('dining', 'Dining', 40)
ON CONFLICT (slug) DO UPDATE SET name = 'Dining', sort_order = 40, active = 1;

UPDATE assr_product_categories SET sort_order = 50 WHERE slug = 'accessories';
UPDATE assr_product_categories SET active = 0 WHERE slug = 'pillow_bolster';
