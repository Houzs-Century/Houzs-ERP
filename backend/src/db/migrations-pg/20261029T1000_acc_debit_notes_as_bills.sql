-- 20261029T1000_acc_debit_notes_as_bills.sql
-- REVERSAL: revert the code first (routes/ap-invoices.ts and routes/other-debtors.ts
--   docKind, the two CN / DN pages' Debit notes tabs). A debit note raised meanwhile
--   stays a valid bill without the column (it posted as an AP invoice / a debtor
--   bill); renumbering is not needed. Then:
--     ALTER TABLE scm.ap_invoices DROP CONSTRAINT IF EXISTS ap_invoices_doc_kind_check;
--     ALTER TABLE scm.ap_invoices DROP COLUMN IF EXISTS doc_kind;
--     ALTER TABLE scm.acc_debtor_bills DROP CONSTRAINT IF EXISTS acc_debtor_bills_doc_kind_check;
--     ALTER TABLE scm.acc_debtor_bills DROP COLUMN IF EXISTS doc_kind;
--   GRANTS: none — the columns ride the tables' existing privileges.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one column on
-- each of two tables, NOT NULL with the constant default 'INV' (every existing row
-- is an invoice — no rewrite on Postgres 11+), and a CHECK every existing row
-- passes. No row is written or altered.
--
-- WHY (owner 2026-10-28: Supplier & Other Creditor CN / DN — 现在的 supplier CN 搬过去，
-- 再加 supplier DN; Customer & Other Debtor CN / DN —「可以」). A debit note from a
-- supplier raises what we owe — AutoCount's A/P Debit Note, which its Creditor
-- Aging lists among the bills (the opening of 31/08 brought 17 in as bills); a
-- debit note to an other debtor raises what they owe. Each is therefore a BILL:
-- an AP invoice paid by the AP Payment's ticks, a debtor bill received by the
-- receipts' ticks, aged and posted exactly as one (source API / ODB). doc_kind
-- says which paper it is — its own number series ({co}SDN- / {co}ODN-), its own
-- title in print, its own tab on the CN / DN pages.

ALTER TABLE scm.ap_invoices ADD COLUMN IF NOT EXISTS doc_kind text NOT NULL DEFAULT 'INV';
ALTER TABLE scm.ap_invoices DROP CONSTRAINT IF EXISTS ap_invoices_doc_kind_check;
ALTER TABLE scm.ap_invoices ADD CONSTRAINT ap_invoices_doc_kind_check CHECK (doc_kind = ANY (ARRAY['INV'::text, 'DN'::text]));

ALTER TABLE scm.acc_debtor_bills ADD COLUMN IF NOT EXISTS doc_kind text NOT NULL DEFAULT 'INV';
ALTER TABLE scm.acc_debtor_bills DROP CONSTRAINT IF EXISTS acc_debtor_bills_doc_kind_check;
ALTER TABLE scm.acc_debtor_bills ADD CONSTRAINT acc_debtor_bills_doc_kind_check CHECK (doc_kind = ANY (ARRAY['INV'::text, 'DN'::text]));
