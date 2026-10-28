-- 051_sales_entries_payment_split.sql
--
-- Sales entries gain payment-split bookkeeping. The flow on event day is:
-- rep takes a deposit (cash / card / EPP) and the balance is chased after
-- the project. Balance is purely derived (amount - deposit_amount) and
-- never persisted.
--
-- Also adds:
--   * ref_no       — receipt / docket number the rep keys in
--   * sales_person_id — who actually closed the sale. Defaults to
--                       created_by but is a separate column because
--                       admins sometimes key the entry on behalf of a
--                       rep at the desk.
--
-- The legacy project-level "Sales Reports" upload (project_sales_reports
-- via /api/projects/:id/sales-reports) is being removed from the UI in
-- the same change. The table + R2 attachments stay so existing data
-- isn't orphaned, same pattern as project_attachments.
--
-- Migrations are immutable (see Decisions): fix forward in a new file
-- if anything here turns out wrong.

ALTER TABLE sales_entries ADD COLUMN ref_no TEXT;
ALTER TABLE sales_entries ADD COLUMN deposit_amount REAL;
ALTER TABLE sales_entries ADD COLUMN deposit_payment_type TEXT;
ALTER TABLE sales_entries ADD COLUMN sales_person_id INTEGER REFERENCES users(id);

-- Backfill: pre-051 rows had no concept of deposit/balance — treat them
-- as fully-deposited so deposit_amount lines up with amount and the
-- derived balance is zero. sales_person_id mirrors created_by.
UPDATE sales_entries SET deposit_amount = amount WHERE deposit_amount IS NULL;
UPDATE sales_entries SET sales_person_id = created_by WHERE sales_person_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_entries_ref_no
  ON sales_entries(ref_no);
CREATE INDEX IF NOT EXISTS idx_sales_entries_sales_person
  ON sales_entries(sales_person_id, occurred_at DESC);
