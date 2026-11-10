-- 20261110T2000_search_trgm_finance_sources.sql — pg_trgm GIN for the columns
-- the top search bar (GET /api/search) now also searches: customers (Other
-- Debtors), credit / debit notes, receipts, delivery returns and payment
-- vouchers. Suppliers are searched too; their code / name / contact_person
-- indexes came in 0240 and are not repeated here.
--
-- WHY. The search bar runs `ILIKE '%term%'` on every keystroke (250 ms
-- debounce). Without a trigram index that is a sequential scan per source per
-- keystroke; at today's row counts it is cheap, which is exactly why it goes
-- unnoticed until the tables have grown (docs/modules/global-search.md, "Add the
-- gin_trgm_ops trigram index for a new searched column in the SAME PR").
-- payment_vouchers.pv_number / payee_name / bill_ref are also what the voucher
-- list's own search box reads (payment-vouchers-list.ts), so it gains as well.
--
-- Column existence was confirmed from the column lists the routes read daily
-- (acc/credit-notes.ts CREDIT_NOTE_HEADER, payment-vouchers-list.ts HEADER,
-- delivery-return-list-read.ts DR_HEADER_COLS, receipts.ts, other-debtors.ts),
-- not from a migration file.
--
-- Idempotent; NOT CONCURRENTLY (the runner wraps each file in a transaction).
--
-- REVERSAL: DROP INDEX IF EXISTS for each of the 15 names below. Indexes only:
-- no data, no grants, no view is touched, so dropping them restores the prior
-- state exactly (searches keep working, as sequential scans).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- scm.acc_debtors — the customer master Finance keeps (Other Debtors).
CREATE INDEX IF NOT EXISTS trgm_scm_debtor_code  ON scm.acc_debtors USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_debtor_name  ON scm.acc_debtors USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_debtor_phone ON scm.acc_debtors USING gin (phone gin_trgm_ops);

-- scm.acc_credit_notes — credit / debit notes.
CREATE INDEX IF NOT EXISTS trgm_scm_cn_number ON scm.acc_credit_notes USING gin (note_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cn_party  ON scm.acc_credit_notes USING gin (party_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cn_so     ON scm.acc_credit_notes USING gin (so_doc_no gin_trgm_ops);

-- scm.acc_receipts (general / sundry) and scm.acc_debtor_receipts.
CREATE INDEX IF NOT EXISTS trgm_scm_rcpt_number   ON scm.acc_receipts USING gin (receipt_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_rcpt_payer    ON scm.acc_receipts USING gin (payer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_drcpt_number  ON scm.acc_debtor_receipts USING gin (receipt_number gin_trgm_ops);

-- scm.delivery_returns.
CREATE INDEX IF NOT EXISTS trgm_scm_dr_number ON scm.delivery_returns USING gin (return_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_dr_do     ON scm.delivery_returns USING gin (do_doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_dr_debtor ON scm.delivery_returns USING gin (debtor_name gin_trgm_ops);

-- scm.payment_vouchers.
CREATE INDEX IF NOT EXISTS trgm_scm_pv_number ON scm.payment_vouchers USING gin (pv_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_pv_payee  ON scm.payment_vouchers USING gin (payee_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_pv_bill   ON scm.payment_vouchers USING gin (bill_ref gin_trgm_ops);
