-- 20261125T1100_acc_daily_bank_voucher_skips.sql
--
-- WHY. Owner 2026-11-25, on a voucher whose money left the bank in October but which
-- Finance re-created and approved after the bank's cash-book start, so the cash book
-- took it off a second time: 「这个是例外，因为他们不小心cancel了」, then, offered a tick
-- per voucher: 「要，加勾选」. The approval-day rule stays; Finance ticks the exception.
--
-- One table, read and written only by Daily Bank's cash book
-- (scm/routes/accounting-daily-bank*.ts). Nothing here posts a journal, touches the
-- ledger or changes the voucher:
--   scm.acc_daily_bank_voucher_skips — an approved payment voucher ticked as "already
--     in the starting balance, don't deduct": the cash book lists it on its day and
--     does not take it off. Untick stamps unticked_at / unticked_by and the row stays;
--     ticking again is a new row. Every tick and untick is also on the audit trail
--     (entity_audit_log, DAILY_BANK_SKIP, keyed by the voucher's id).
-- pv_id names a voucher of the same company (the route checks it); there is no
-- foreign key, so nothing here can hold up a voucher's own writes.
--
-- MULTI-COMPANY. company_id on every row; the routes scope reads and writes to the
-- active company (scm/lib/companyScope.ts).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no seed. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_daily_bank_voucher_skips;
--   Revert the code first. Dropping loses every tick: the cash book takes those
--   vouchers off again. The ledger and the vouchers are untouched either way.
--   GRANTS: none to re-apply; the table is new.

CREATE TABLE IF NOT EXISTS scm.acc_daily_bank_voucher_skips (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  pv_id         UUID NOT NULL,
  ticked_by     TEXT NULL,
  ticked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  unticked_by   TEXT NULL,
  unticked_at   TIMESTAMPTZ NULL
);

-- One live tick per voucher; the board's read is every live tick of the company.
CREATE UNIQUE INDEX IF NOT EXISTS acc_daily_bank_voucher_skips_one_live
  ON scm.acc_daily_bank_voucher_skips (company_id, pv_id)
  WHERE unticked_at IS NULL;

-- Like every scm table (mig 0061): RLS on with no policy, so only the service role the
-- Worker uses reads or writes it.
ALTER TABLE scm.acc_daily_bank_voucher_skips ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_daily_bank_voucher_skips TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_daily_bank_voucher_skips IS
  'Daily Bank cash book: an approved payment voucher ticked as already in its bank''s starting balance, so the cash book does not take it off. '
  'unticked_at set = unticked (kept for the trail). Read only by Daily Bank; never posts to the ledger.';

NOTIFY pgrst, 'reload schema';
