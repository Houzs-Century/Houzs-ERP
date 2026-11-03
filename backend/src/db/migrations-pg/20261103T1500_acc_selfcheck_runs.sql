-- 20261103T1500_acc_selfcheck_runs.sql
-- Books › Self-check, summed for To do (the owner's Claude Design, batch 6
-- c3, 2026-11-03). The control check is too heavy to run on every To do read,
-- so each run of it leaves one row here: when it ran, how many of its checks
-- name something to look at, and the one-line items To do shows ("HC-SI-…
-- journal RM 120.00 short", "2 payments not in the books", …). Written by
-- the nightly 00:05 run and by Self-check's Run again
-- (POST /accounting/self-check/run); To do reads the newest row per company.
--
-- Reads and a summary only — nothing here posts to the books.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_selfcheck_runs;

CREATE TABLE IF NOT EXISTS scm.acc_selfcheck_runs (
  id          bigserial   PRIMARY KEY,
  company_id  bigint      NOT NULL,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  trigger     text        NOT NULL CHECK (trigger IN ('cron', 'manual')),
  ran_by      text,
  checks      integer     NOT NULL CHECK (checks >= 0),
  findings    integer     NOT NULL CHECK (findings >= 0),
  items       jsonb       NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS acc_selfcheck_runs_latest ON scm.acc_selfcheck_runs (company_id, ran_at DESC);
