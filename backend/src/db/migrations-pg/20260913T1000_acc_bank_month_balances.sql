-- 20260913T1000_acc_bank_month_balances.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_bank_month_balances; — the table is new
--   and additive: nothing existing is altered, backfilled or referenced by a
--   foreign key, and dropping it returns every month to "no typed figure",
--   which is exactly the state the database is in today. GRANTS: none to
--   re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NEW TABLE. The deployed application keeps working unchanged whether or
-- not this has run — the routes that read it ship in the same PR and treat
-- "no row" as "nothing typed", which is the state of every month the moment
-- this applies.
--
-- WHY IT EXISTS (docs/bugs/0858). Maybank's Account Activity Report prints
-- movements and no balance — not an opening, not a closing. The month is
-- assembled by acc/bank-month.ts, and its rule 2 takes a balance only off a
-- file that prints one, so a Maybank month had no figure to tally against and
-- could never be closed. Owner, 2026-09-13, on the proposal that he type the
-- month-end figure off the bank's own statement once: 做.
--
-- WHAT A ROW IS. One per company × bank account × month: the CLOSING balance
-- of that month as the bank's month-end statement prints it, typed by a person.
-- The month it belongs to opens where the previous one closed, so a month's
-- opening is the previous month's row — there is no opening column, because a
-- second copy of the same fact would be a second thing to keep right. A figure
-- a FILE prints always wins over a typed one (acc/bank-month.ts rule 4), so a
-- row for a Hong Leong month is harmless and unused.
--
-- WHO AND WHEN are kept on the row, and the reconciliation report names them:
-- a figure somebody typed is a claim, and a claim with no author is a number
-- nobody can check.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.acc_bank_month_balances (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  account_code  TEXT    NOT NULL,
  -- The month itself, as its first day — the same shape acc_bank_month_locks
  -- keys by, so the two tables read and range the same way.
  period_month  DATE    NOT NULL,

  -- The closing balance of the month per the bank's own statement, in sen.
  -- Signed: an overdrawn account closes below zero.
  closing_sen   BIGINT  NOT NULL,
  -- Where it was read off, in the typist's words ("per the June e-statement").
  note          TEXT,

  typed_by      TEXT,
  typed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ONE figure per company × account × month. Typing again replaces it; there
  -- is no history to keep, because the figure is the bank's and the bank's
  -- statement is the record.
  CONSTRAINT acc_bank_month_balances_one_per_month UNIQUE (company_id, account_code, period_month)
);
