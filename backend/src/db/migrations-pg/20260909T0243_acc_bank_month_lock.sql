-- 20260909T0243_acc_bank_month_lock.sql
--
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_bank_month_locks; — the table is new
--   and additive, nothing reads it that did not ship with it, and no existing
--   row in any other table is touched or referenced by a foreign key. Dropping
--   it returns every month to "never locked", which is exactly the state the
--   database is in today.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NEW TABLE. Nothing existing is altered, backfilled or dropped, so the
-- deployed application keeps working unchanged whether or not this has run —
-- the routes that read it ship in the same PR and treat "no row" as "not
-- locked", which is the state of every month the moment this applies.
--
-- WHY IT EXISTS. Owner, 2026-09-08, having asked for the month view and the
-- report: 还有lock 起来不可以随便碰.
--
-- Until now every bank movement could be booked, ignored or UNDONE at any time,
-- for ever. That is right while a month is being worked and wrong the moment it
-- has been reconciled and its statement printed: a reconciliation somebody filed
-- is a claim about a month, and a month that can still move behind the paper
-- makes the paper a lie. So a reconciled month can be closed, and a closed month
-- refuses every write that would change what it says.
--
-- WHAT A LOCK IS. One row per company × bank account × month. Its presence is
-- the lock; `released_at` being set is the record that it was opened again, and
-- the row STAYS — an unlock is an event somebody has to be able to find later,
-- not the absence of one. That is why this is not a boolean column on a
-- statement: a statement is a file, a lock is about a MONTH, and the month is
-- assembled from however many files fed it (acc/bank-month.ts).
--
-- WHAT IT IS NOT. This is not a GL period close. It stops the bank
-- reconciliation screens from changing a closed month; it does not stop a
-- journal entry being posted into those dates from anywhere else in the system.
-- Naming that limit here so nobody later reads this table as a guarantee it
-- does not make.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.acc_bank_month_locks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  account_code  TEXT    NOT NULL,
  -- The month itself, as its first day. A DATE rather than 'YYYY-MM' text so a
  -- range query over locked months is an index scan and not a string parse.
  period_month  DATE    NOT NULL,

  -- WHAT WAS TRUE WHEN IT WAS LOCKED. Snapshotted, never recomputed: the whole
  -- point of a lock is that it fixes a claim, and a claim that silently follows
  -- today's data is not a claim. If the ledger later disagrees with these
  -- figures, that disagreement is the finding — recomputing them would erase it.
  closing_statement_sen BIGINT,
  closing_ledger_sen    BIGINT,
  difference_sen        BIGINT,
  -- How many files the month was assembled from, and whether the chain of them
  -- covered it end to end, at the moment of locking.
  statement_count       INTEGER NOT NULL DEFAULT 0,
  was_complete          BOOLEAN NOT NULL DEFAULT false,

  locked_by     TEXT,
  locked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Why it was locked while something was still missing. Required by the route
  -- in that case, because a month closed over a gap is a decision somebody made
  -- and this sentence is the whole record of it.
  lock_note     TEXT,

  -- The unlock, kept rather than deleted.
  released_by   TEXT,
  released_at   TIMESTAMPTZ,
  release_note  TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE LIVE LOCK per company × account × month. Partial, so a month may be
-- locked, released and locked again — each attempt keeps its own row and its own
-- reason, and only one of them is in force at a time.
CREATE UNIQUE INDEX IF NOT EXISTS acc_bank_month_lock_live
  ON scm.acc_bank_month_locks (company_id, account_code, period_month)
  WHERE released_at IS NULL;

-- The read every guarded write makes: is THIS month of THIS account locked.
CREATE INDEX IF NOT EXISTS acc_bank_month_locks_co
  ON scm.acc_bank_month_locks (company_id, account_code, period_month DESC);
