-- Migrated INVOICES — the second half of the cutover paperwork.
--
-- Owner 2026-08-11: "那些 GR 已经 convert 成 purchase invoice 了，所以你应该要转成
-- purchase invoice，DO 也应该要转成 sales invoice 吧？跟着它的链路，它的
-- documentation relationship map 去完善调到完." Then twice, narrowing it: "我说的是
-- 我们ERP 的DO to Invoice / 我们ERP的GR to PI" and "而不是全部" — convert the
-- documents ALREADY IN THIS ERP, do NOT import AutoCount's invoice history.
--
-- Migration 0276 gave scm.grns and scm.delivery_orders `migrated_no_stock`: a
-- document carried over from AutoCount whose real-world effect already happened
-- somewhere else, so the ERP must post NOTHING behind it. An invoice raised from
-- such a document inherits exactly that property, and the column keeps the same
-- name so ONE predicate finds every carried-over document in the system.
--
-- What "post nothing" means for an INVOICE specifically — invoices never move
-- stock in this ERP (PI is AP-only, SI is AR-only), so the flag is not about
-- stock here. It is about money:
--
--   * NO general ledger. AutoCount already booked this payable / this revenue.
--     A migrated PI must not post Dr 1200 / Cr 2000, and a migrated SI must not
--     post Dr 1100 / Cr 4000, or the two books double-count the same money.
--     Enforced in postPiAccounting and postSiRevenue, which both re-read the
--     header — so the guard covers every caller rather than every call site.
--   * NO customer credit. Applying credit against a migrated SI would spend a
--     real customer balance a second time — the customer silently loses money
--     still owed to them. Enforced in applyCustomerCreditToSi, which re-reads
--     the header, so every caller is covered rather than every call site. Note
--     what this does NOT stop, deliberately: a payment an operator records
--     against a migrated invoice behaves normally, and cancelling that invoice
--     still turns the paid amount into credit. That money moved in THIS book and
--     is ours to account for; what is refused is spending a standing balance on
--     paperwork AutoCount already settled.
--   * NO AutoCount write-back. The invoice being mirrored IS the AutoCount
--     invoice; pushing it back creates a duplicate in the live account book.
--
-- linked_ac_docno carries the AutoCount INVOICE number this row mirrors, and the
-- document number itself is built from it (owner's standing rule: everything
-- carried over from AutoCount keeps AutoCount's number). check-migrated-numbering
-- enforces that on all six document types now.
ALTER TABLE scm.purchase_invoices
  ADD COLUMN IF NOT EXISTS migrated_no_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_ac_docno text;

ALTER TABLE scm.sales_invoices
  ADD COLUMN IF NOT EXISTS migrated_no_stock boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS linked_ac_docno text;

COMMENT ON COLUMN scm.purchase_invoices.migrated_no_stock IS
  'TRUE = paperwork carried over from AutoCount at the 2026-08 cutover, mirroring a purchase invoice AutoCount already raised. Post NO general ledger entry for it (AutoCount holds the payable) and never enqueue it to the AutoCount write-back (the invoice it mirrors is already there). Written only by scripts/create-migrated-invoices.mjs; the convert routes refuse a migrated source. See docs/autocount-cutover-ledger.md.';
COMMENT ON COLUMN scm.purchase_invoices.linked_ac_docno IS
  'The AutoCount PI document number this row mirrors. invoice_number is HC- || this value.';
COMMENT ON COLUMN scm.sales_invoices.migrated_no_stock IS
  'TRUE = paperwork carried over from AutoCount at the 2026-08 cutover, mirroring a sales invoice AutoCount already raised. Post NO revenue/AR journal, apply NO customer credit, and never enqueue it to the AutoCount write-back. Written only by scripts/create-migrated-invoices.mjs; the convert routes refuse a migrated source. See docs/autocount-cutover-ledger.md.';
COMMENT ON COLUMN scm.sales_invoices.linked_ac_docno IS
  'The AutoCount sales-invoice document number this row mirrors (AutoCount numbers these I-…, not IV-…). invoice_number is HC- || this value.';

-- Finding them is a predicate, not a guess (mirrors 0276).
CREATE INDEX IF NOT EXISTS purchase_invoices_migrated_no_stock_idx
  ON scm.purchase_invoices (company_id) WHERE migrated_no_stock;
CREATE INDEX IF NOT EXISTS sales_invoices_migrated_no_stock_idx
  ON scm.sales_invoices (company_id) WHERE migrated_no_stock;

-- Idempotency for the converter, enforced by the database rather than by the
-- script remembering to check: one ERP invoice per AutoCount invoice per
-- company. A re-run cannot create a second copy even if its own guard is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_migrated_ac_docno_uq
  ON scm.purchase_invoices (company_id, linked_ac_docno) WHERE migrated_no_stock;
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_migrated_ac_docno_uq
  ON scm.sales_invoices (company_id, linked_ac_docno) WHERE migrated_no_stock;

-- DELIBERATELY NOT ADDED: a linked_ac_inv_docnos array on scm.delivery_orders,
-- the sales-side twin of scm.purchase_orders.linked_ac_pinv_docnos. The
-- converter reads the AutoCount relationship map from
-- backend/scripts/data/ac-invoice-refs.json.gz instead. Migration 0273 added
-- purchase_order_items.linked_ac_dtlkey for the same kind of purpose and it is
-- populated on 0 of 864 rows — a column that looks authoritative and is empty is
-- worse than no column, because the next reader joins on it and gets silence.
