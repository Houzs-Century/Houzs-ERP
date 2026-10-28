-- 032_po_docs_raw.sql
-- Stash the full AutoCount /PurchaseOrder/getAll payload as JSON on
-- each purchase_order_docs row so the UI can let users opt-in to any
-- of the ~150 fields that AutoCount returns (Branch*, CreditorAreaCode,
-- Footer*Tax, etc.) without us having to whitelist each one in the
-- schema. The default Columns view stays minimal; users pick extras
-- from the Columns panel.

ALTER TABLE purchase_order_docs ADD COLUMN raw TEXT;
