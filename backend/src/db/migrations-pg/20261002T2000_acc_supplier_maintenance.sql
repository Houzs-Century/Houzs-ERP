-- 20261002T2000_acc_supplier_maintenance.sql
-- REVERSAL: ALTER TABLE scm.suppliers
--             DROP COLUMN IF EXISTS for_purchasing,
--             DROP COLUMN IF EXISTS bank_name,
--             DROP COLUMN IF EXISTS bank_account_no,
--             DROP COLUMN IF EXISTS bank_account_name;
--   Revert the code first: routes/suppliers.ts selects and writes the four
--   columns (SUPPLIER_COLS, create, PATCH) and hides a for_purchasing = false
--   supplier from a caller who is not Finance; routes/supplier-maintenance.ts
--   reads them. Dropping loses every bank detail Finance typed, and every
--   Finance-only supplier shows to purchasing again.
--   GRANTS: none to re-apply — a column rides its table's grants. The list
--   view scm.suppliers_with_derived_category froze its s.* at CREATE time
--   (mig 0084), so it neither gains nor loses these columns: the list route
--   reads the purchasing tick from the base table.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-02; the four columns read back from information_schema in the PR
--   body. The UPDATE names production rows, so it matches nothing on staging.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four new
-- columns on scm.suppliers — one NOT NULL boolean with a default (every
-- existing supplier stays shared with purchasing) and three nullable text
-- columns — then ONE UPDATE that marks the twelve suppliers the owner named as
-- Finance-only. No other row is written. Applied by the Deploy run before the
-- Worker that selects the columns.
--
-- WHY (owner 2026-10-02, Supplier Maintenance in Finance › Money out):
--   A2a 「Finance 开的 supplier 只有 Finance 看得到，采购看不到」 — a supplier
--       Finance opens (a landlord, a utility, an other creditor) is Finance's
--       alone: for_purchasing = false hides it from purchasing's screens and
--       API; Finance ticks 「采购也用」 to share it.
--   A3a 「加上银行资料，付款时自动带出来」 — the supplier's bank, so a payment
--       carries where the money goes. Part of the Finance half of the record
--       (shared/supplier-finance-fields.ts): purchasing never reads or writes it.
--   The existing suppliers (「可以」 to the list of twelve): other creditors —
--       a 405- code, or a code that is not 400-/405- at all — that purchasing
--       never used. The NOT EXISTS guards keep a supplier purchasing has used
--       shared, even if its code were among these.

ALTER TABLE scm.suppliers
  ADD COLUMN IF NOT EXISTS for_purchasing    boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bank_name         text,
  ADD COLUMN IF NOT EXISTS bank_account_no   text,
  ADD COLUMN IF NOT EXISTS bank_account_name text;

UPDATE scm.suppliers s
   SET for_purchasing = false
 WHERE (s.company_id, s.code) IN (
         (1, '23600599248'),
         (1, '405-M004'),
         (1, '511090010014761'),
         (1, '5623 8450 2460'),
         (2, '405-G001'),
         (2, '405-H001'),
         (2, '405-H002'),
         (2, '405-L001'),
         (2, '405-M001'),
         (2, '405-T001'),
         (2, '405-U001'),
         (2, '405-Y001')
       )
   AND NOT EXISTS (SELECT 1 FROM scm.purchase_orders   po WHERE po.supplier_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM scm.grns              g  WHERE g.supplier_id  = s.id)
   AND NOT EXISTS (SELECT 1 FROM scm.purchase_invoices pi WHERE pi.supplier_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM scm.purchase_returns  pr WHERE pr.supplier_id = s.id);
