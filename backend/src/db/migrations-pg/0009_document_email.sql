-- 0009_document_email.sql (Postgres). Mirror of D1 098_document_email.sql.
-- customer_email recipient + DO-email sent guard + OFF-by-default customer
-- channels. All idempotent (pg-migrate requirement). All new timestamp data is
-- TEXT (written via the shim's datetime('now')) — NOT timestamptz — per the
-- lesson from mig 0008.

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_email text;
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_email ON sales_orders(customer_email);

ALTER TABLE delivery_tracking ADD COLUMN IF NOT EXISTS do_email_sent_at text;

INSERT INTO app_settings (key, value) VALUES
  ('email.delivery_order',  '{"value":false}'),
  ('email.invoice',         '{"value":false}'),
  ('email.document_report', '{"value":false}')
ON CONFLICT (key) DO NOTHING;
