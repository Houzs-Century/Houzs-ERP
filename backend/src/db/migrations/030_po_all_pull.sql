-- 030_po_all_pull.sql
-- The PO sync now pulls every line (delivered + outstanding) instead
-- of only outstanding. We need a few extra columns:
--   • original_qty    — the line's full Qty from AutoCount, so
--                        delivered lines (remaining_qty=0) still show
--                        their original spend in the P&L.
--   • is_outstanding  — derived flag (1 = remaining_qty > 0). Stored
--                        because the UI's tab/filter is hot path and
--                        an index on a computed column is awkward in
--                        D1's SQLite.
--   • doc_status      — pass-through of AutoCount DocStatus (so the
--                        UI can show "Cancelled" rows distinctly).
--   • cancelled       — 1 if the upstream PO was cancelled.
--
-- All nullable so existing rows don't blow up; the next sync repopulates.

ALTER TABLE purchase_orders ADD COLUMN original_qty REAL;
ALTER TABLE purchase_orders ADD COLUMN is_outstanding INTEGER DEFAULT 0;
ALTER TABLE purchase_orders ADD COLUMN doc_status TEXT;
ALTER TABLE purchase_orders ADD COLUMN cancelled INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_po_outstanding ON purchase_orders(is_outstanding, doc_date);
CREATE INDEX IF NOT EXISTS idx_po_cancelled ON purchase_orders(cancelled);
