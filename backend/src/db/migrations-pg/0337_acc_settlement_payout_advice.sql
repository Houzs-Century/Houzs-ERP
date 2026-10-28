-- REVERSAL: additive only.
--   DROP TABLE scm.acc_settlement_payout_batches;
--   DROP TABLE scm.acc_settlement_payouts;
-- No existing table or row is modified.
--
-- THE PAYOUT ADVICE — the document that says which reports one credit pays.
--
-- Owner, 2026-08-20, stating the shape in one line: for pbb 就是几份 excel 对
-- 一份 pdf. Public Bank sends a transaction file PER SETTLEMENT DATE and, when
-- it pays, ONE IBG advice covering several of them:
--
--   HOUZSCENTURY_CSV_20260807.csv  RM 37,537.66  ─┐
--   HOUZSCENTURY_CSV_20260808.csv  RM 52,269.93  ─┼─> IBG advice 10 Aug
--   HOUZSCENTURY_CSV_20260809.csv  RM 99,148.27  ─┘   RM 188,955.86
--                                                      -> one bank credit
--
-- Those figures are from his own files, and the third is equal to the sen to
-- what that day's CSV nets — the chain closes on real money.
--
-- WHY THIS NEEDS TO BE STORED rather than recomputed. Without the advice the
-- bank matcher has to SEARCH for a combination of reconciled reports adding up
-- to the credit, and it caps that search at four; a payout covering ten days
-- would never be found, and a wrong combination that happened to add up would
-- be worse. The advice is the answer written down by the party paying — so it
-- is kept, and the matcher reads it instead of guessing.
-- NOTE: number re-checked against the tree at merge time.

-- 1. One payout, as the acquirer announced it.
CREATE TABLE scm.acc_settlement_payouts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       INTEGER NOT NULL,
  acquirer_code    TEXT    NOT NULL REFERENCES scm.acc_acquirer_config (code),
  file_name        TEXT    NOT NULL,
  -- The same guard the statements use: one document is one payout, and a
  -- second upload of it must lose rather than double the money expected.
  file_hash        TEXT    NOT NULL,
  -- The advice's own date — usually the day the credit appears on the bank.
  advice_date      DATE,
  -- Where the acquirer says it paid. Kept as the DOCUMENT's claim so a payout
  -- landing in a different account can be seen to have done so, rather than
  -- silently reconciling against whichever bank was configured.
  payee_bank       TEXT,
  payee_account_no TEXT,
  gross_sen        BIGINT  NOT NULL DEFAULT 0,
  commission_sen   BIGINT  NOT NULL DEFAULT 0,
  -- What the bank statement will show as ONE credit.
  net_sen          BIGINT  NOT NULL,
  -- What the document PRINTED as its own total. The reader refuses unless the
  -- rows reach it, so these are equal on every stored row — kept because a
  -- screen showing both never has to be believed.
  printed_net_sen  BIGINT,
  uploaded_by      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_payout_once UNIQUE (company_id, file_hash)
);

CREATE INDEX acc_settlement_payouts_co
  ON scm.acc_settlement_payouts (company_id, acquirer_code, advice_date DESC);

COMMENT ON TABLE scm.acc_settlement_payouts IS
  'One payout an acquirer announced, covering SEVERAL settlement dates. Public '
  'Bank''s IBG advice is the case it was built for: 几份 excel 对一份 pdf.';

-- 2. What that payout is made of — one row per settlement date it covers.
--
-- The settlement DATE, not the EDC batch. The advice groups by terminal batch
-- (48 of them on his August file) but a merchant report in this system is one
-- uploaded FILE covering one settlement date, so the date is the grain the two
-- sides share. The batch detail stays in the file; what is stored is what can
-- actually be matched.
--
-- batch_id is nullable ON PURPOSE: an advice can name a day whose report has
-- not been uploaded yet, and that is a fact worth holding — it is the screen's
-- answer to "what am I still missing before this payout can be booked".
CREATE TABLE scm.acc_settlement_payout_batches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id    BIGINT  NOT NULL REFERENCES scm.acc_settlement_payouts (id) ON DELETE CASCADE,
  company_id   INTEGER NOT NULL,
  settled_on   DATE    NOT NULL,
  -- What the ADVICE says that day came to. Compared against the report's own
  -- net; a difference is the finding, not something to average away.
  net_sen      BIGINT  NOT NULL,
  batch_id     BIGINT  REFERENCES scm.acc_settlement_batches (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_payout_day_once UNIQUE (payout_id, settled_on)
);

CREATE INDEX acc_settlement_payout_batches_batch
  ON scm.acc_settlement_payout_batches (batch_id);
