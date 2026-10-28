-- 116_note_categories.sql — D1 test mirror of migrations-pg/0108
-- Timeline note categories (Nick 2026-07-14): the manual-note audience
-- 'purchasing' is renamed 'service' and split into four buckets —
-- service / customer / supplier / sales. Supplier-portal posts move to
-- 'supplier'; portal comments/uploads gain a category so the timeline
-- filter chips can group them. Only 'customer' is portal-visible.

UPDATE assr_activity SET category = 'supplier'
 WHERE category = 'purchasing' AND source_channel = 'supplier_portal';

UPDATE assr_activity SET category = 'sales'
 WHERE action IN ('sales_comment', 'sales_upload')
   AND (category IS NULL OR category = 'purchasing');

UPDATE assr_activity SET category = 'customer'
 WHERE action IN ('customer_comment', 'customer_upload')
   AND category IS NULL;

UPDATE assr_activity SET category = 'service' WHERE category = 'purchasing';
