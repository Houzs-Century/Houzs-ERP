-- D1 / test-tree twin of migrations-pg/20261014T1711_pos_discount_approver.sql.
ALTER TABLE pos_sale_lines ADD COLUMN discount_by TEXT;
ALTER TABLE pos_sales ADD COLUMN bill_discount_by TEXT;
