-- 20260912T0300_acc_deposit_invoices.sql
--
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_deposit_invoices; DROP TABLE IF EXISTS scm.acc_company_settings;
--   The journal entries an issued deposit invoice wrote stay in the ledger
--   (source_type DI / DI_REVERSAL); cancel the invoices on the screen first
--   if the entries must go too, or leave them as history.
--
-- WHAT THIS IS. Deposit invoices (owner 2026-09-12: e-invoice 好像是根据收钱
-- 就认 sales 了 — money received is a sale the day it is received, so every
-- deposit gets an invoice of its own, and the customer's own code is the
-- debit side, not a deposit liability). One DEPOSIT INVOICE per customer
-- payment received before the order's final sales invoice exists:
--   Dr AR (party = the customer's code)  /  Cr DEPOSIT PAY BY CUSTOMER
--   (role DEPOSIT_INCOME, 509-0000 — a sales account, the owner's pick).
-- At the final invoice the design raises one credit note per deposit
-- invoice (credit_note_id below is where that link lands); a payment made
-- AFTER the final invoice settles the invoice and gets no deposit invoice.
--
-- The switch is PER COMPANY with a start date (owner 2026-09-12: 做成开关，
-- houzs 那边往后也是需要，只是暂时先关闭 … 可以自己选几时要开始自动开
-- deposit invoice): scm.acc_company_settings holds it — the first per-company
-- settings row the accounting layer has (companies carries id, code, name,
-- is_active, created_at and nothing else). Off everywhere until Finance
-- turns it on; a payment dated before the start date is left alone.
--
-- Numbering: {co}-DI-YYMM-NNN — a NEW series (flagged to the owner
-- 2026-09-12, 可以). One ACTIVE invoice per payment (the partial unique index
-- below): an edited payment cancels its invoice by contra and issues the
-- next number, the way an e-invoice is cancelled and re-issued, never
-- re-used.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

CREATE TABLE IF NOT EXISTS scm.acc_company_settings (
  company_id              bigint      NOT NULL PRIMARY KEY,
  deposit_invoice_enabled boolean     NOT NULL DEFAULT false,
  deposit_invoice_from    date,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              text
);

CREATE TABLE IF NOT EXISTS scm.acc_deposit_invoices (
  id               uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       bigint      NOT NULL,
  di_number        text        NOT NULL,
  payment_source   text        NOT NULL DEFAULT 'SOPAY' CHECK (payment_source IN ('SOPAY')),
  payment_id       text        NOT NULL,
  so_doc_no        text        NOT NULL,
  party_code       text,
  party_name       text,
  invoice_date     date        NOT NULL,
  amount_sen       bigint      NOT NULL CHECK (amount_sen > 0),
  method           text,
  status           text        NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'CANCELLED')),
  je_no            text,
  credit_note_id   uuid        REFERENCES scm.acc_credit_notes (id),
  cancel_reason    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  cancelled_at     timestamptz,
  cancelled_by     text,
  UNIQUE (company_id, di_number)
);

-- One invoice STANDING per payment; a cancelled one steps aside for the re-issue.
CREATE UNIQUE INDEX IF NOT EXISTS acc_deposit_invoices_active_payment_idx
  ON scm.acc_deposit_invoices (payment_source, payment_id)
  WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS acc_deposit_invoices_company_date_idx
  ON scm.acc_deposit_invoices (company_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS acc_deposit_invoices_order_idx
  ON scm.acc_deposit_invoices (so_doc_no);
