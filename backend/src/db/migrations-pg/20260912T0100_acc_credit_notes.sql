-- 20260912T0100_acc_credit_notes.sql
--
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_credit_note_lines; DROP TABLE IF EXISTS scm.acc_credit_notes;
--   The journal entries a POSTED note wrote stay in the ledger (source_type
--   CN / DN / SCN); cancel the notes on the screen first if the entries must
--   go too, or leave them as history.
--
-- WHAT THIS IS. Credit and debit notes (owner 2026-09-05: CN/DN approved —
-- sales CN + supplier CN first, DN second, prefixes CN / DN / SCN, new
-- number series; 2026-09-12: 这个要做). One table for the three kinds:
--   CN  — a credit note TO A CUSTOMER: Dr each line's account (RETURN
--         INWARDS by default) / Cr the AR control, party the customer.
--   DN  — a debit note TO A CUSTOMER: Dr the AR control, party the customer
--         / Cr each line's account.
--   SCN — a credit note FROM A SUPPLIER: Dr the supplier's AP control (400 or
--         405 by the supplier's code) / Cr each line's account (PURCHASES
--         RETURN by default).
-- A note is DRAFT until posted; posting writes one journal keyed
-- (source_type = kind, source_doc_no = note_number); cancel writes the
-- contra. The paper it comes from — a delivery return DR-…, a purchase
-- return PRT-…, an invoice — is named on the row, not enforced: the first
-- cut is the accountant's own note, raised by hand. The deposit-invoice
-- design (2026-09-12) will raise a CN per deposit invoice automatically at
-- delivery; it keys on sales_invoice_id.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

CREATE TABLE IF NOT EXISTS scm.acc_credit_notes (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint      NOT NULL,
  note_number         text        NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('CN', 'DN', 'SCN')),
  party_type          text        NOT NULL CHECK (party_type IN ('CUSTOMER', 'SUPPLIER')),
  party_code          text,
  party_name          text,
  supplier_id         uuid        REFERENCES scm.suppliers (id),
  so_doc_no           text,
  sales_invoice_id    uuid,
  ap_invoice_id       uuid        REFERENCES scm.ap_invoices (id),
  purchase_invoice_id uuid,
  -- The paper this note answers: a delivery return, a purchase return, an
  -- invoice number, a customer's complaint reference. Free text, shown.
  source_doc_no       text,
  note_date           date        NOT NULL,
  total_sen           bigint      NOT NULL DEFAULT 0,
  reason              text,
  notes               text,
  status              text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  je_no               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  posted_at           timestamptz,
  posted_by           text,
  cancelled_at        timestamptz,
  cancelled_by        text,
  UNIQUE (company_id, note_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_company_status ON scm.acc_credit_notes (company_id, status);
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_company_kind   ON scm.acc_credit_notes (company_id, kind);
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_company_so     ON scm.acc_credit_notes (company_id, so_doc_no);
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_company_si     ON scm.acc_credit_notes (company_id, sales_invoice_id);

CREATE TABLE IF NOT EXISTS scm.acc_credit_note_lines (
  id           uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   bigint NOT NULL,
  note_id      uuid   NOT NULL REFERENCES scm.acc_credit_notes (id) ON DELETE CASCADE,
  line_no      int    NOT NULL,
  description  text,
  account_code text   NOT NULL,
  amount_sen   bigint NOT NULL CHECK (amount_sen > 0)
);
CREATE INDEX IF NOT EXISTS idx_acc_credit_note_lines_note ON scm.acc_credit_note_lines (note_id);

COMMENT ON TABLE scm.acc_credit_notes IS
  'Credit and debit notes (docs/bugs/0827): CN to a customer, DN to a customer, SCN from a supplier; one journal per posted note, source_type = kind.';
