-- 20261123T1200_acc_daily_bank_cashbook.sql
--
-- WHY. Owner 2026-11-23: Daily Bank becomes his own cash book. The ledger's bank
-- balances are far from what the banks hold, and he chose not to adjust the books
-- for it: 「先做一个daily bank的一开始直接，但不需要列实际差额。然后我每天会手动输入收到的金额」,
-- payments 「付款就根据pv」.
--
-- Two tables, read and written only by Daily Bank (scm/routes/accounting-daily-bank*.ts).
-- Nothing here posts a journal or touches the ledger:
--   scm.acc_daily_bank_starts   — per money account, the bank's real balance at the
--                                 START of a day (the day before's closing). One row per
--                                 account; a change is an edit, recorded on the audit trail.
--   scm.acc_daily_bank_receipts — money actually received, typed by hand per bank and day,
--                                 with a note saying who or what. A delete stamps
--                                 deleted_at / deleted_by and the row stays.
-- An account with a start reads: start + typed receipts - approved vouchers paying out of
-- it (on their voucher date, from the start date on). One without keeps the ledger.
--
-- MULTI-COMPANY. company_id on every row; the routes scope reads and writes to the active
-- company (scm/lib/companyScope.ts).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no seed. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_daily_bank_receipts;
--   DROP TABLE IF EXISTS scm.acc_daily_bank_starts;
--   Revert the code first. Dropping loses every starting balance and typed receipt (copy
--   them out first if they are wanted); the ledger is untouched either way.
--   GRANTS: none to re-apply; both tables are new.

CREATE TABLE IF NOT EXISTS scm.acc_daily_bank_starts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  account_code  TEXT NOT NULL,
  start_date    DATE NOT NULL,
  -- May be negative: an overdrawn account starts below zero.
  balance_sen   BIGINT NOT NULL,
  note          TEXT NULL,
  set_by        TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_daily_bank_starts_one_per_account UNIQUE (company_id, account_code)
);

CREATE TABLE IF NOT EXISTS scm.acc_daily_bank_receipts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  account_code  TEXT NOT NULL,
  receipt_date  DATE NOT NULL,
  amount_sen    BIGINT NOT NULL,
  note          TEXT NOT NULL,
  created_by    TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by    TEXT NULL,
  deleted_at    TIMESTAMPTZ NULL,
  CONSTRAINT acc_daily_bank_receipts_amount_positive CHECK (amount_sen > 0),
  CONSTRAINT acc_daily_bank_receipts_note_given CHECK (btrim(note) <> '')
);

-- The board's read (an account's receipts from its start to the day) and the Cash book
-- tab's (one day's receipts, deleted ones included).
CREATE INDEX IF NOT EXISTS idx_acc_daily_bank_receipts_account_day
  ON scm.acc_daily_bank_receipts (company_id, account_code, receipt_date);
CREATE INDEX IF NOT EXISTS idx_acc_daily_bank_receipts_day
  ON scm.acc_daily_bank_receipts (company_id, receipt_date);

-- Like every scm table (mig 0061): RLS on with no policy, so only the service role the
-- Worker uses reads or writes them.
ALTER TABLE scm.acc_daily_bank_starts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.acc_daily_bank_receipts ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_daily_bank_starts TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_daily_bank_receipts TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_daily_bank_starts IS
  'Daily Bank cash book: per money account, the bank''s real balance at the start of start_date. '
  'Read only by Daily Bank; never posts to the ledger.';
COMMENT ON TABLE scm.acc_daily_bank_receipts IS
  'Daily Bank cash book: money received, typed by hand per bank and day. deleted_at set = deleted (kept for the trail). '
  'Read only by Daily Bank; never posts to the ledger.';

NOTIFY pgrst, 'reload schema';
