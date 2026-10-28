-- 0132_email_purchase_order_channel.sql
-- Seed the supplier-facing "purchase_order" email channel OFF (owner flips it on
-- when ready). A PO reaches an external supplier ONLY when this is true AND a
-- human takes the send action — fail-closed, same posture as the customer
-- document channels seeded in 0009_document_email.sql. Idempotent.

INSERT INTO app_settings (key, value) VALUES
  ('email.purchase_order', '{"value":false}')
ON CONFLICT (key) DO NOTHING;
