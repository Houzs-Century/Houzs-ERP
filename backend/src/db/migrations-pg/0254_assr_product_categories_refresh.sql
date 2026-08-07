-- 0254_assr_product_categories_refresh.sql
-- Nico 2026-08-04: the Service Case "Product Category" dropdown should read
-- Bedframe / Sofa / Mattress / Dining / Accessories, in that order.
-- "Bed Frame" becomes one word, Dining is new, and Pillow / Bolster is
-- retired. Retired = active 0, not deleted: the row is what renders the
-- label on the one historical case that still carries it, and the lookup
-- endpoint already filters on active = 1 for the form.
-- Slugs never change (they are the stable key); only names/order do.

UPDATE assr_product_categories SET name = 'Bedframe', sort_order = 10 WHERE slug = 'bed_frame';
UPDATE assr_product_categories SET sort_order = 20 WHERE slug = 'sofa';
UPDATE assr_product_categories SET sort_order = 30 WHERE slug = 'mattress';

INSERT INTO assr_product_categories (slug, name, sort_order) VALUES ('dining', 'Dining', 40)
ON CONFLICT (slug) DO UPDATE SET name = 'Dining', sort_order = 40, active = 1;

UPDATE assr_product_categories SET sort_order = 50 WHERE slug = 'accessories';
UPDATE assr_product_categories SET active = 0 WHERE slug = 'pillow_bolster';
