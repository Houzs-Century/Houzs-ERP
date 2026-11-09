-- 20261109T1200_scm_supplier_email2_email3.sql
-- REVERSAL: ALTER TABLE scm.suppliers
--             DROP COLUMN IF EXISTS email2,
--             DROP COLUMN IF EXISTS email3;
--   Revert the code first: routes/suppliers.ts selects and writes both columns
--   (SUPPLIER_COLS, create, PATCH), and every supplier embed on the PO / GRN /
--   PI / purchase-return / consignment reads names them. Dropping loses every
--   Email 2 / Email 3 typed in, and the PO email goes back to one address.
--   GRANTS: none to re-apply — a column rides its table's grants. The list view
--   scm.suppliers_with_derived_category froze its s.* at CREATE time (mig 0084),
--   so it neither gains nor loses these columns.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- nullable text columns on scm.suppliers. No default, no backfill, no row is
-- written. Applied by the Deploy run before the Worker that selects them.
--
-- WHY (owner 2026-11-09: "supplier email needs email 2 and 3"): a supplier has
-- more than one person who must see a PO. The PO "send to supplier" email goes
-- To = email and Cc = email2 / email3 (shared/supplier-emails.ts).

ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS email2 text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS email3 text;
