-- 20261117T1700_acc_bank_card_settlements.sql
--
-- WHY. Owner 2026-11-17, on 2990's Hong Leong credit of RM 26,308.81 on 13/11
-- (Houzs's HC-HPV-2611-052): three of 2990's instalment sales were swiped on
-- Houzs's AEON terminal, Houzs paid 2990 the money less AEON's charges, and no
-- 2990 merchant report will ever carry those swipes — 「我在bank recon时可以选
-- 刷卡的transaction，然后差额就直接去terminal charges」, then 「照这样做」.
--
-- One row per card payment (SOPAY = an order's payment, SIPAY = an invoice's)
-- that a bank movement took in directly: which movement, the gross it cleared
-- out of its card clearing account, and the journal that did it (source
-- SETTLECARD, acc/bank-card-settle.ts). A payment a merchant report line holds
-- (scm.acc_settlement_matches) cannot be taken here, and one taken here cannot
-- be held by a report line: the two triggers below refuse the second claim with
-- 23505, the answer acc_settlement_payment_once already gives two report lines,
-- so every writer of either table is refused the same way.
--
-- A movement holding card payments cannot be deleted (RESTRICT): its journal
-- would stand with nothing on the bank explaining it.
--
-- MULTI-COMPANY. company_id on every row; the routes scope reads and writes to
-- the active company.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL: undo every such match on Bank Recon first, so each SETTLECARD
-- journal is reversed (a row dropped while its journal stands leaves card
-- clearing credited by an entry nothing explains); then:
--   DROP TRIGGER IF EXISTS acc_settlement_match_not_bank_card ON scm.acc_settlement_matches;
--   DROP FUNCTION IF EXISTS scm.acc_settlement_match_not_bank_card();
--   DROP TABLE IF EXISTS scm.acc_bank_card_settlements;
--   DROP FUNCTION IF EXISTS scm.acc_bank_card_not_on_report();

CREATE TABLE IF NOT EXISTS scm.acc_bank_card_settlements (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id             BIGINT NOT NULL REFERENCES public.companies(id),
  bank_line_id           BIGINT NOT NULL REFERENCES scm.acc_bank_statement_lines (id) ON DELETE RESTRICT,
  payment_source         TEXT NOT NULL,
  payment_id             TEXT NOT NULL,
  doc_no                 TEXT NULL,
  gross_sen              BIGINT NOT NULL,
  clearing_account_code  TEXT NOT NULL,
  received_on            DATE NOT NULL,
  je_no                  TEXT NULL,
  created_by             TEXT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_bank_card_source CHECK (payment_source IN ('SOPAY', 'SIPAY')),
  CONSTRAINT acc_bank_card_gross CHECK (gross_sen > 0),
  CONSTRAINT acc_bank_card_payment_once UNIQUE (payment_source, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_bank_card_settlements_line
  ON scm.acc_bank_card_settlements (company_id, bank_line_id);

ALTER TABLE scm.acc_bank_card_settlements ENABLE ROW LEVEL SECURITY;

-- ── One payment, one settler ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION scm.acc_bank_card_not_on_report() RETURNS trigger
LANGUAGE plpgsql
SET search_path = scm, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM scm.acc_settlement_matches m
              WHERE m.payment_source = NEW.payment_source AND m.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment_on_merchant_report: % % is held by a merchant report line', NEW.payment_source, NEW.payment_id
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acc_bank_card_not_on_report ON scm.acc_bank_card_settlements;
CREATE TRIGGER acc_bank_card_not_on_report
  BEFORE INSERT OR UPDATE OF payment_source, payment_id ON scm.acc_bank_card_settlements
  FOR EACH ROW EXECUTE FUNCTION scm.acc_bank_card_not_on_report();

CREATE OR REPLACE FUNCTION scm.acc_settlement_match_not_bank_card() RETURNS trigger
LANGUAGE plpgsql
SET search_path = scm, public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM scm.acc_bank_card_settlements b
              WHERE b.payment_source = NEW.payment_source AND b.payment_id = NEW.payment_id) THEN
    RAISE EXCEPTION 'payment_taken_by_bank: % % was taken in by a bank movement', NEW.payment_source, NEW.payment_id
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS acc_settlement_match_not_bank_card ON scm.acc_settlement_matches;
CREATE TRIGGER acc_settlement_match_not_bank_card
  BEFORE INSERT OR UPDATE OF payment_source, payment_id ON scm.acc_settlement_matches
  FOR EACH ROW EXECUTE FUNCTION scm.acc_settlement_match_not_bank_card();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rest of the acc tables.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_bank_card_settlements TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_bank_card_settlements IS
  'Card payments (SOPAY/SIPAY) a bank movement took in directly, no merchant report carrying them: '
  'the movement, the gross cleared out of card clearing and its SETTLECARD journal. See acc/bank-card-settle.ts.';

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
