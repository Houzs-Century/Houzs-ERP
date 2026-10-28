-- 098_document_email.sql (D1/SQLite). Mirror of migrations-pg/0009_document_email.sql.
-- Foundation for auto-emailing customer-facing documents (Delivery Order now;
-- Invoice / Report reuse the same stack later) off the existing Resend +
-- email_outbox + app_settings infrastructure.
--
--  1. sales_orders.customer_email — the recipient for a DO/invoice email.
--     AutoCount debtor sync carries only debtor_name + phone (NO email), so this
--     is a Houzs-side, manually-maintained column. Empty = no send (the sender
--     no-ops on a missing recipient — no customer is ever emailed without one).
--  2. delivery_tracking.do_email_sent_at — set when the DO email actually sends;
--     doubles as the once-only guard (a retried dispatch can't re-notify) and a
--     record of when the customer was told. TEXT (datetime('now')), per the
--     text-timestamp rule.
--  3. Channel toggles seeded OFF — customer-facing email is high-stakes; nothing
--     reaches a real customer until an admin flips the toggle in Settings.

ALTER TABLE sales_orders ADD COLUMN customer_email TEXT;
CREATE INDEX IF NOT EXISTS idx_sales_orders_customer_email ON sales_orders(customer_email);

ALTER TABLE delivery_tracking ADD COLUMN do_email_sent_at TEXT;

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('email.delivery_order',  '{"value":false}'),
  ('email.invoice',         '{"value":false}'),
  ('email.document_report', '{"value":false}');
