-- 20260905T1200_stock_month_close.sql
-- REVERSAL: ALTER TABLE scm.inventory_movements DROP COLUMN IF EXISTS movement_date;
--           DROP TABLE IF EXISTS scm.acc_stock_close_runs;
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One nullable date column on scm.inventory_movements, backfilled from the
--   movements' own SOURCE DOCUMENTS where those carry a business date, plus
--   one new empty table for the month-close run log. No existing reader
--   changes behaviour: every current consumer of inventory_movements ignores
--   the new column, and readers that WANT it read
--   coalesce(movement_date, created_at::date) so a null is simply "entered
--   the day it happened".
--
-- WHY (owner, 2026-09-05, GL redesign item 4). Stock value reaches the GL as
-- a month-end adjustment grabbed from the LIVE engine — and the owner's first
-- question was the right one: 如果他们迟进 GRN 呢? A GRN keyed on Sep 2 for
-- goods received Aug 30 must count in AUGUST's closing value. Movements only
-- carried created_at (the keying moment), so an as-of replay dated late
-- entries into the wrong month with no way back. movement_date is the
-- BUSINESS date:
--   • GRN rows     ← grns.received_at        (the date the operator keyed as
--                                             the receipt date — his answer,
--                                             not the system's guess)
--   • DO rows      ← dispatched_at, else do_date (stock leaves at dispatch)
--   • everything else (AC_CUTOVER, adjustments, transfers, PC_RECEIVE, DR)
--     ← created_at::date — those are keyed as they happen; a later source
--       can start stamping its own date through writeMovements at any time.
--
-- scm.acc_stock_close_runs is the visible trail the owner asked for (我有没有
-- 办法看到你每天检查的成果): one row per close/check/re-post, whatever the
-- outcome.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS; the backfills only touch
-- rows still NULL, so a re-run is a no-op).

SET search_path = scm, public;

ALTER TABLE scm.inventory_movements ADD COLUMN IF NOT EXISTS movement_date date;

UPDATE scm.inventory_movements m
SET movement_date = g.received_at::date
FROM scm.grns g
WHERE m.movement_date IS NULL
  AND m.source_doc_type = 'GRN'
  AND m.source_doc_no = g.grn_number
  AND g.received_at IS NOT NULL;

UPDATE scm.inventory_movements m
SET movement_date = coalesce(d.dispatched_at::date, d.do_date)
FROM scm.delivery_orders d
WHERE m.movement_date IS NULL
  AND m.source_doc_type = 'DO'
  AND m.source_doc_no = d.do_number
  AND coalesce(d.dispatched_at::date, d.do_date) IS NOT NULL;

UPDATE scm.inventory_movements
SET movement_date = created_at::date
WHERE movement_date IS NULL;

CREATE INDEX IF NOT EXISTS inventory_movements_movement_date_idx
  ON scm.inventory_movements (company_id, movement_date);

CREATE TABLE IF NOT EXISTS scm.acc_stock_close_runs (
  id              bigserial PRIMARY KEY,
  company_id      integer NOT NULL,
  month           text NOT NULL,             -- 'YYYY-MM', the month being closed
  ran_at          timestamptz NOT NULL DEFAULT now(),
  trigger         text NOT NULL,             -- 'cron' | 'manual'
  stock_value_sen bigint NOT NULL,
  action          text NOT NULL,             -- 'posted' | 'unchanged' | 'reposted' | 'failed'
  je_no           text,
  rev_je_no       text,
  note            text
);

CREATE INDEX IF NOT EXISTS acc_stock_close_runs_month_idx
  ON scm.acc_stock_close_runs (company_id, month, ran_at DESC);
