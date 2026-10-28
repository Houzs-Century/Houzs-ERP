-- 070_sales_entries_so_form.sql
--
-- Boss provided mockups for a richer "New Sales Order" form. The
-- existing /sales EntryPanel only captures customer + amount + deposit;
-- the new form adds delivery dates, branding, multi-line address,
-- venue / warehouse, payment status, line items, and multi-payment
-- support.
--
-- Strategy:
--   1. ALTER sales_entries to add new columns. All nullable so existing
--      rows continue to render.
--   2. CREATE sales_entry_items   — one row per item line (qty/price).
--   3. CREATE sales_entry_payments — one row per payment received.
--      Replaces today's single-deposit columns; deposit_amount and
--      deposit_payment_type stay populated for backward compat with the
--      list view.
--
-- Doc number generator (`SO-NNNNNN`) lives in services/salesEntries.ts.

-- ── Header columns on sales_entries ──────────────────────────
ALTER TABLE sales_entries ADD COLUMN doc_no TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_entries_doc_no
  ON sales_entries(doc_no) WHERE doc_no IS NOT NULL;

ALTER TABLE sales_entries ADD COLUMN processing_date TEXT;
ALTER TABLE sales_entries ADD COLUMN delivery_date TEXT;
ALTER TABLE sales_entries ADD COLUMN status_2 TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_address_2 TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_postcode TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_state TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_phone_2 TEXT;
ALTER TABLE sales_entries ADD COLUMN customer_email TEXT;
ALTER TABLE sales_entries ADD COLUMN venue TEXT;
ALTER TABLE sales_entries ADD COLUMN warehouse TEXT;
ALTER TABLE sales_entries ADD COLUMN branding TEXT;
ALTER TABLE sales_entries ADD COLUMN po_doc_no TEXT;
ALTER TABLE sales_entries ADD COLUMN payment_status TEXT;
ALTER TABLE sales_entries ADD COLUMN source TEXT;
ALTER TABLE sales_entries ADD COLUMN remarks TEXT;

-- ── Line items ───────────────────────────────────────────────
-- One row per item on the SO. UI computes amount = qty * unit_price
-- but we store it so reports / aggregates don't have to recompute.
CREATE TABLE sales_entry_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES sales_entries(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL DEFAULT 0,
  item_code       TEXT,
  item_description TEXT,
  remarks         TEXT,
  qty             REAL    NOT NULL DEFAULT 1,
  unit_price      REAL    NOT NULL DEFAULT 0,
  amount          REAL    NOT NULL DEFAULT 0,
  group_tag       TEXT,
  created_at      TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_entry_items_entry ON sales_entry_items(entry_id);

-- ── Payments ────────────────────────────────────────────────
-- One row per payment received against the SO. The first row's amount
-- is mirrored into sales_entries.deposit_amount on save so the list
-- view's "Deposit" column keeps rendering for new rows.
CREATE TABLE sales_entry_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        INTEGER NOT NULL REFERENCES sales_entries(id) ON DELETE CASCADE,
  paid_at         TEXT    NOT NULL,
  payment_method  TEXT    NOT NULL,
  amount          REAL    NOT NULL,
  account_sheet   TEXT,
  approval_code   TEXT,
  collected_by    TEXT,
  created_at      TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX idx_sales_entry_payments_entry ON sales_entry_payments(entry_id);
