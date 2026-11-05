-- 20261105T2000_acc_credit_note_sales_invoice_target.sql
-- A customer's credit note knocks off the customer's SALES INVOICES (owner
-- 2026-11-03: 「要」, his design "like AutoCount"; batch 5 spec c6 / f2). Until
-- now an application named a purchase invoice, an AP invoice or an other
-- debtor's bill only, so a customer CN knocked off nothing.
--
-- WHY A ROW AND NOT paid_sen. The knock-off posts nothing — the note's own
-- journal (Dr its lines / Cr 300-0000 Trade Debtors for the customer) already
-- carries the credit. The row says which invoice the credit came off and how
-- much (applied_sen), and every reader of an invoice's outstanding subtracts
-- it beside the order's deposit (scm/lib/si-credit-notes.ts). It is kept OUT
-- of sales_invoices.paid_sen on purpose: paid_sen feeds the overpayment rule
-- (customer-credits.ts reconcileSiOverpay — money above the total becomes
-- customer credit), so a credit written there would turn a later full payment
-- into customer credit. Deposit close-out notes are never written here: the
-- order's deposit already lowers that invoice.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column (every existing row reads NULL), the one-target CHECK
-- rewritten to say the same thing for the three existing targets plus the new
-- one (every existing row has exactly one of the three, so it passes), and one
-- partial index. No row is written or altered; no function, view or grant.
-- ON DELETE RESTRICT, as for the other targets: an invoice a credit came off
-- keeps its record.
--
-- REVERSAL:
--   Revert the code first (acc/credit-note-allocations.ts SI targets,
--   scm/lib/si-credit-notes.ts, routes/credit-notes.ts). Take every knock-off
--   off the sales invoices first (each customer note's Knock off, or cancel the
--   note), or the old CHECK refuses to come back while an invoice row stands:
--   DROP INDEX IF EXISTS scm.idx_acc_cn_alloc_sales_invoice;
--   ALTER TABLE scm.acc_credit_note_allocations DROP CONSTRAINT IF EXISTS acc_credit_note_allocations_one_target;
--   ALTER TABLE scm.acc_credit_note_allocations ADD CONSTRAINT acc_credit_note_allocations_one_target
--     CHECK (num_nonnulls(purchase_invoice_id, ap_invoice_id, debtor_bill_id) = 1);
--   ALTER TABLE scm.acc_credit_note_allocations DROP COLUMN IF EXISTS sales_invoice_id;
--   GRANTS: none — a column on an existing table rides that table's grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_credit_note_allocations
  ADD COLUMN IF NOT EXISTS sales_invoice_id uuid
    REFERENCES scm.sales_invoices (id) ON DELETE RESTRICT;

ALTER TABLE scm.acc_credit_note_allocations DROP CONSTRAINT IF EXISTS acc_credit_note_allocations_one_target;
ALTER TABLE scm.acc_credit_note_allocations ADD CONSTRAINT acc_credit_note_allocations_one_target
  CHECK (num_nonnulls(purchase_invoice_id, ap_invoice_id, debtor_bill_id, sales_invoice_id) = 1);

CREATE INDEX IF NOT EXISTS idx_acc_cn_alloc_sales_invoice
  ON scm.acc_credit_note_allocations (sales_invoice_id)
  WHERE sales_invoice_id IS NOT NULL;
