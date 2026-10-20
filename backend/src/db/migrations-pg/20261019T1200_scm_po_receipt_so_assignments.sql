-- 20261019T1200_scm_po_receipt_so_assignments.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.po_receipt_so_assignments;
--   Revert the code first (scm/lib/receipt-so-assignment.ts writes it from
--   grns.ts postGrnAndRollup; routes/procurement-overview.ts reads it).
--   GRANTS: the explicit service_role grant below goes with the table.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes. No existing table or value is touched.
-- Verified against: the local restore of production (houzs_local, 2026-10-19).
--
-- WHY (owner, 2026-10-18/19): a PO raised for stock (no sales-order line on
-- it) carries no customer date, so the lead-time figures could not say how
-- early those goods arrived against the customer who later took them — 3 of
-- 187 mattress receipts in October had one. MRP decides which open order a
-- receipt serves, but computes it live and keeps nothing. This keeps it: when
-- a goods receipt posts, its stock-PO lines are assigned to the open sales-
-- order lines of the same item, earliest delivery date first (MRP's rule), and
-- each assignment is written here with that customer date.
--
-- One row per (goods-receipt line, sales-order line) slice. need_date is the
-- order's delivery date at the moment of receipt (amended, else original).

CREATE TABLE IF NOT EXISTS scm.po_receipt_so_assignments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              BIGINT NOT NULL,
  grn_id                  UUID NOT NULL,
  purchase_order_item_id  UUID NOT NULL,
  so_item_id              UUID NOT NULL,
  so_doc_no               TEXT NOT NULL,
  item_code               TEXT NOT NULL,
  qty                     NUMERIC NOT NULL CHECK (qty > 0),
  need_date               DATE,
  received_at             DATE NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT po_receipt_so_assignments_one_slice UNIQUE (grn_id, purchase_order_item_id, so_item_id)
);

CREATE INDEX IF NOT EXISTS idx_po_receipt_so_asg_company_po_item ON scm.po_receipt_so_assignments (company_id, purchase_order_item_id);
CREATE INDEX IF NOT EXISTS idx_po_receipt_so_asg_so_item ON scm.po_receipt_so_assignments (so_item_id);

-- The Worker reads and writes as service_role; granted explicitly rather than
-- trusting the schema's default privileges (a local restore lacked them).
GRANT SELECT, INSERT, UPDATE, DELETE ON scm.po_receipt_so_assignments TO service_role;
