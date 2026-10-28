-- 031_purchase_order_docs.sql
-- Doc-level mirror of AutoCount Purchase Orders. Populated from
-- /PurchaseOrder/getAll which returns header rows (no line items).
-- Used by:
--   • the P&L module — sums `local_ex_tax` per month for cost
--   • the PO "Documents" tab — one row per PO with status badge, total,
--     creditor, etc. Complements purchase_orders (which is line-level
--     and only carries outstanding lines from /getOutstanding).
--
-- Why a separate table: /getAll and /getOutstanding return different
-- shapes (header-only vs flat header+line). Mashing them into the
-- same table needed sentinel rows and was a footgun. Two tables keep
-- the contract honest: one table per upstream endpoint.

CREATE TABLE IF NOT EXISTS purchase_order_docs (
  doc_no         TEXT PRIMARY KEY,
  doc_date       TEXT,
  ref            TEXT,
  so_doc_no      TEXT,
  creditor_code  TEXT,
  creditor_name  TEXT,
  purchase_location TEXT,
  doc_status     TEXT,
  cancelled      INTEGER DEFAULT 0,
  -- All amounts in local currency (RM) for direct P&L use:
  local_ex_tax   REAL,
  local_tax      REAL,
  local_net_total REAL,
  final_total    REAL,
  currency_code  TEXT,
  currency_rate  REAL,
  remark1        TEXT,
  remark2        TEXT,
  remark3        TEXT,
  remark4        TEXT,
  note           TEXT,
  last_modified  TEXT,
  -- Manual override pattern, mirrors purchase_orders.amount_source:
  amount_source  TEXT,    -- 'sync' or 'manual'
  amount_updated_at TEXT,
  amount_updated_by INTEGER,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_po_docs_date ON purchase_order_docs(doc_date);
CREATE INDEX IF NOT EXISTS idx_po_docs_status ON purchase_order_docs(cancelled, doc_status);
CREATE INDEX IF NOT EXISTS idx_po_docs_creditor ON purchase_order_docs(creditor_code);

-- Drop the now-redundant columns we tried to bolt onto purchase_orders
-- in 030. They're only meaningful at doc level. Index drops too.
DROP INDEX IF EXISTS idx_po_outstanding;
DROP INDEX IF EXISTS idx_po_cancelled;
-- (We leave the columns in place — SQLite ALTER DROP isn't supported
-- without a table rebuild and the columns are nullable / harmless.)
