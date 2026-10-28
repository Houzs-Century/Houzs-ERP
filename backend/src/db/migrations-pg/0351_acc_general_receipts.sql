-- 0351: General Receipts — money in that belongs to NOBODY in a registry
-- (owner 2026-09-03: 就我只想开 receipt 罢了; and on ceremony: 不需要走四层，
-- 就录入就好，错就 delete 或 void).
--
-- A receipt records who paid (free text — no registry档案 for one-off
-- payers), which money account it landed on, and lines that each pick their
-- own credit account, exactly the Debtor Bill's line discipline. It posts
-- DIRECTLY on create (source RCT: Dr bank / Cr the lines), and the only
-- undo is VOID — an RCT_REVERSAL contra plus status CANCELLED, because a
-- posted document leaves the ledger by reversal, never by vanishing.
--
-- Customer money deliberately has NO table here: 顾客的钱 keeps flowing
-- through the sales payments it always used; the Receipts page merely LISTS
-- those rows read-only beside these.
--
-- Verified against: backend/tests/receipts.test.ts (the route contract with
-- the real engine posting into the harness) and the staging rehearsal,
-- which applies this before any prod deploy runs it.
-- Reversal: DROP TABLE scm.acc_receipt_lines; DROP TABLE scm.acc_receipts;

CREATE TABLE IF NOT EXISTS scm.acc_receipts (
  id                uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        bigint      NOT NULL,
  receipt_number    text        NOT NULL,
  payer_name        text        NOT NULL,
  receipt_date      date        NOT NULL,
  bank_account_code text        NOT NULL,
  total_sen         bigint      NOT NULL,
  status            text        NOT NULL DEFAULT 'POSTED', -- POSTED | CANCELLED
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  UNIQUE (company_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS idx_acc_receipts_company_date
  ON scm.acc_receipts (company_id, receipt_date);

CREATE TABLE IF NOT EXISTS scm.acc_receipt_lines (
  id                  uuid   NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint NOT NULL,
  receipt_id          uuid   NOT NULL REFERENCES scm.acc_receipts(id) ON DELETE CASCADE,
  line_no             int    NOT NULL,
  description         text,
  credit_account_code text   NOT NULL,
  amount_sen          bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acc_receipt_lines_receipt
  ON scm.acc_receipt_lines (receipt_id);
