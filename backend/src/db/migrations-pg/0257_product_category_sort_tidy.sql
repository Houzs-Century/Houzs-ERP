-- 0257_product_category_sort_tidy.sql
-- 0254 gave Dining sort_order 40 without moving the retired Pillow / Bolster
-- off 40, so the two tie. The form never shows it (active = 1 only), but the
-- Service Maintenance list with "include inactive" ticked orders them
-- arbitrarily. Park retired entries past the live ones instead.

UPDATE assr_product_categories SET sort_order = 900 WHERE slug = 'pillow_bolster';
