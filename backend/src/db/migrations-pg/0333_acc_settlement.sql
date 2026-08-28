-- REVERSAL: additive only.
--   DROP TABLE scm.acc_settlement_matches;
--   DROP TABLE scm.acc_settlement_rows;
--   DROP TABLE scm.acc_settlement_batches;
-- No existing table or row is modified.
--
-- acc_settlement — phase 2B layer 3: acquirer settlement reconciliation
-- (brief §3.5 layer 3). B2C card money is not in the bank on the day it is
-- swiped: the customer pays 1,000, the acquirer keeps its fee, and 985 arrives
-- days later. Reconciliation IS the process of emptying the settlement-in-
-- transit account (320-0000) — and 系统3's fatal defect was that it only ever
-- SHOWED differences, never booked them, so card fees never touched the P&L
-- and the profit was overstated for years.
--
-- Here, confirming a match posts THAT MOMENT (brief §3.5: 对账确认的那一刻就
-- 产生分录): Dr bank + Dr fee / Cr the acquirer's transit.
-- NOTE: number re-checked against the tree at merge time.

-- 1. One uploaded statement file.
CREATE TABLE scm.acc_settlement_batches (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  acquirer_code  TEXT    NOT NULL REFERENCES scm.acc_acquirer_config (code),
  file_name      TEXT    NOT NULL,
  -- Content fingerprint. Re-uploading the same file is refused LOUDLY rather
  -- than silently doubling a day's settlement (§2.14).
  file_hash      TEXT    NOT NULL,
  period_from    DATE,
  period_to      DATE,
  row_count      INTEGER NOT NULL DEFAULT 0,
  gross_sen      BIGINT  NOT NULL DEFAULT 0,
  fee_sen        BIGINT  NOT NULL DEFAULT 0,
  net_sen        BIGINT  NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'OPEN',   -- OPEN | CLEARED
  uploaded_by    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_batch_status CHECK (status IN ('OPEN', 'CLEARED')),
  CONSTRAINT acc_settlement_batch_once UNIQUE (company_id, file_hash)
);

CREATE INDEX acc_settlement_batches_co ON scm.acc_settlement_batches (company_id, acquirer_code, created_at DESC);

-- 2. One line of that statement.
--
-- `bucket` is the FOUR piles the screen shows (brief §3.5: 底层可记更细的状态,
-- 画面只给四堆); `confirmed_at` + `posted_je_no` carry the finer truth of
-- whether that pile has actually reached the ledger yet.
CREATE TABLE scm.acc_settlement_rows (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       BIGINT  NOT NULL REFERENCES scm.acc_settlement_batches (id) ON DELETE CASCADE,
  company_id     INTEGER NOT NULL,
  acquirer_code  TEXT    NOT NULL,
  line_no        INTEGER NOT NULL,           -- position in the file, for "row 42 of the CSV"
  txn_date       DATE    NOT NULL,
  ref            TEXT,                       -- the acquirer's unique reference, when it has one
  -- Negative is legal: a refund or chargeback line settles the other way.
  gross_sen      BIGINT  NOT NULL,
  fee_sen        BIGINT  NOT NULL DEFAULT 0,
  net_sen        BIGINT  NOT NULL,
  bucket         TEXT    NOT NULL DEFAULT 'UNMATCHED',
  -- How the match was reached — shown as the clue on screen, and the reason a
  -- no-unique-ref acquirer can never claim 'ref'.
  match_reason   TEXT,                       -- ref | amount+date | manual
  confirmed_at   TIMESTAMPTZ,
  confirmed_by   TEXT,
  posted_je_no   TEXT,
  posted_je_id   TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_row_bucket CHECK (
    bucket IN ('MATCHED', 'NEEDS_CONFIRM', 'UNMATCHED', 'IGNORED')
  ),
  CONSTRAINT acc_settlement_row_reason CHECK (
    match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual')
  ),
  -- Fees are a deduction, never a negative deduction.
  CONSTRAINT acc_settlement_row_fee CHECK (fee_sen >= 0),
  CONSTRAINT acc_settlement_row_line UNIQUE (batch_id, line_no)
);

CREATE INDEX acc_settlement_rows_bucket ON scm.acc_settlement_rows (company_id, bucket, txn_date);
CREATE INDEX acc_settlement_rows_batch  ON scm.acc_settlement_rows (batch_id, line_no);

-- 3. Which ERP payment rows a settlement line covers. A separate table because
--    one settlement can cover SEVERAL orders (the brief's 一笔刷卡对应两张订单),
--    and because the second-layer guarantee belongs in the database:
--
--    acc_settlement_payment_once — a payment row may be settled ONCE. A second
--    statement line claiming the same payment loses the insert and is routed to
--    NEEDS_CONFIRM for a human, instead of quietly clearing the same money twice.
CREATE TABLE scm.acc_settlement_matches (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_row_id BIGINT  NOT NULL REFERENCES scm.acc_settlement_rows (id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL,
  payment_source    TEXT    NOT NULL,        -- SOPAY | SIPAY (the ledger source_type)
  payment_id        TEXT    NOT NULL,        -- the payment ROW uuid the ledger keyed on
  doc_no            TEXT,                    -- SO/invoice number, for the screen
  amount_sen        BIGINT  NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_match_source CHECK (payment_source IN ('SOPAY', 'SIPAY')),
  CONSTRAINT acc_settlement_payment_once UNIQUE (payment_source, payment_id)
);

CREATE INDEX acc_settlement_matches_row ON scm.acc_settlement_matches (settlement_row_id);
