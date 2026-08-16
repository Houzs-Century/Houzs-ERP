-- REVERSAL: additive only. DROP TABLE scm.acc_daily_closes; no existing row
-- is modified.
--
-- acc_daily_close — phase 2B: the daily cashup (brief §3.5 layer 2). Each day
-- each company closes the drawer: the system's recorded takings per bucket
-- (cash / each acquirer / online transfer) against what was actually counted.
-- Cash differences POST as over/short the moment the close is confirmed
-- (§3.5: 对账确认的那一刻就产生分录) — card/transfer differences are timing,
-- resolved by the layer-3 acquirer reconciliation, so they are recorded here
-- but never papered over with an entry.
-- NOTE: number re-checked against the tree at merge time.

CREATE TABLE scm.acc_daily_closes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  close_date   DATE    NOT NULL,
  -- 'cash' | 'transfer' | an acquirer code (CIMB/GHL/...)
  bucket       TEXT    NOT NULL,
  system_sen   BIGINT  NOT NULL DEFAULT 0,
  counted_sen  BIGINT,
  diff_sen     BIGINT GENERATED ALWAYS AS (COALESCE(counted_sen, 0) - system_sen) STORED,
  status       TEXT    NOT NULL DEFAULT 'DRAFT',  -- DRAFT | CONFIRMED
  notes        TEXT,
  created_by   TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_daily_close_status CHECK (status IN ('DRAFT', 'CONFIRMED')),
  -- One row per company+date+bucket: re-counting updates, never duplicates.
  CONSTRAINT acc_daily_close_unique UNIQUE (company_id, close_date, bucket)
);

CREATE INDEX acc_daily_closes_date ON scm.acc_daily_closes (company_id, close_date);
