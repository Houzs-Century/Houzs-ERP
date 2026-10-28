-- 052_sales_entries_customer_contact.sql
--
-- Sales entries gain customer contact fields. Event-floor sales are
-- B2C — the rep needs the buyer's address and phone for the post-event
-- balance chase, and the AutoCount customer code (B2B-only) is being
-- dropped from the form. The customer_code column itself stays so any
-- pre-052 row that does have a code keeps it; the form just doesn't
-- collect new codes anymore.
--
-- Migrations are immutable (see Decisions): fix forward in a new file
-- if anything here turns out wrong.

ALTER TABLE sales_entries ADD COLUMN customer_address TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_entries_customer_phone
  ON sales_entries(customer_phone);
