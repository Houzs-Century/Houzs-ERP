-- 146_product_category_sort_tidy.sql
-- D1 test mirror of migrations-pg/0257 (SQLite dialect).

UPDATE assr_product_categories SET sort_order = 900 WHERE slug = 'pillow_bolster';
