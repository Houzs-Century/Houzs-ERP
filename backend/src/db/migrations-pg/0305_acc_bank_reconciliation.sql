-- REVERSAL: additive only.
--   ALTER TABLE scm.acc_settlement_receipts DROP COLUMN bank_line_id;
--   DROP TABLE scm.acc_bank_statement_matches;
--   DROP TABLE scm.acc_bank_statement_lines;
--   DROP TABLE scm.acc_bank_statements;
--   DROP TABLE scm.acc_bank_recognition_rules;
--   DROP TABLE scm.acc_bank_statement_config;
-- No existing table or row is modified.
--
-- Layer 4, phase 4 — reconciling the BANK's own statement.
--
-- Owner, 2026-08-19, looking at a screen that asked him to type the date and
-- the amount of every payout by hand: 我不是应该upload bank statement 或 daily
-- transaction report 然后你也自动核对吗? He is right, and asked for the whole
-- job, not just the card half: 整张月结单全部对.
--
-- So the shape mirrors layer 3 deliberately — a file becomes a batch, a batch
-- has lines, a line claims what it matches — because it is the same job on the
-- other side of the money, and an operator who has learnt one screen has learnt
-- both.
--
-- What is NOT here, on purpose: no balance column anywhere. A reconciliation is
-- computed from the ledger every time it is asked for (§2.3, no caches), and a
-- stored "reconciled balance" is the exact artefact that lets the books and the
-- statement drift apart while both look settled.
-- NOTE: number re-checked against the tree at merge time.

-- 1. How to READ a given bank account's statements.
--
-- The two real files could hardly be less alike, which is the whole argument
-- for config over code:
--
--   Maybank  ACCOUNTACTIVITYREPORT_564418610346.csv — PIPE delimited, 22
--            columns, dates 20260801, amounts 000000000171000 (integer sen,
--            zero-padded to 15) and CR/DR in a column of its own.
--   Hong Leong  acs_23600602788_*.pdf — decimal amounts, debit and credit in
--            separate columns, and a running balance.
CREATE TABLE scm.acc_bank_statement_config (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  -- The MONEY account in the chart of accounts this statement belongs to.
  -- The join to reality: a statement is reconciled against a ledger account,
  -- not against a bank's name.
  account_code      TEXT    NOT NULL,
  -- For the screen, and for refusals that name the bank rather than "the file".
  bank_code         TEXT    NOT NULL,
  -- The real account number as the bank prints it. An upload whose file names
  -- a different account is REFUSED: reconciling the wrong account is the one
  -- mistake here that produces a clean-looking wrong answer.
  account_no        TEXT,
  statement_format  TEXT    NOT NULL DEFAULT 'CSV',   -- CSV | TXT | PDF
  -- NULL means a comma. Maybank's is '|'.
  delimiter         TEXT,
  -- 'decimal' | 'integer-sen'. See the header for what integer-sen costs if
  -- it is read as a decimal: RM 1,710.00 becomes RM 171,000,000.
  amount_format     TEXT    NOT NULL DEFAULT 'decimal',
  -- The value of the indicator column that means money came IN.
  credit_indicator  TEXT    NOT NULL DEFAULT 'CR',
  -- Which heading holds what: date, description, reference, amount/indicator
  -- or debit/credit, balance. Named by heading TEXT, matched case- and
  -- space-insensitively, because banks re-caption between exports.
  column_map        JSONB   NOT NULL DEFAULT '{}'::jsonb,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_bank_cfg_format CHECK (statement_format IN ('CSV', 'TXT', 'PDF')),
  CONSTRAINT acc_bank_cfg_amount CHECK (amount_format IN ('decimal', 'integer-sen')),
  CONSTRAINT acc_bank_cfg_once   UNIQUE (company_id, account_code)
);

COMMENT ON TABLE scm.acc_bank_statement_config IS
  'How to read one bank account''s statement file. Per company because the same '
  'bank pays different companies into different accounts, and per account '
  'because a company banks in more than one place.';

-- 2. How to recognise an acquirer's money ON the bank statement.
--
-- The brief is explicit that this rule must exist the moment the acquirer does
-- — 系统3 had four acquirers and two rules, so two acquirers' money read as
-- 永远收不到 forever. GLOBAL, like acc_acquirer_config: how Public Bank writes
-- its credit advice does not vary by which company is receiving it.
--
-- The four real shapes, from docs/acquirer-statement-formats.md:
--   MBB   CR/CARD SALES MN <merchant> DATED <DDMMYYYY>   (net credited)
--         DR/CARD SALES M/N <merchant> DATED <DDMMYYYY>  (gross, fee separate)
--   PBB   03999061714  PBB-PBCS AC 3
--   AEON  Book Transfer Third AEON CREDIT SERVICE
--   HLB   blank sender, CA Credit Advice, ref …MERCHANT <YYYYMMDD>
CREATE TABLE scm.acc_bank_recognition_rules (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  acquirer_code        TEXT    NOT NULL REFERENCES scm.acc_acquirer_config (code),
  -- A regular expression, applied case-insensitively.
  pattern              TEXT    NOT NULL,
  -- description | reference | both. Hong Leong names its trading day in the
  -- REFERENCE and nothing useful in the description, so this is not cosmetic.
  match_field          TEXT    NOT NULL DEFAULT 'both',
  -- Regex whose first capture group is the TRADING day being settled — not the
  -- day the money landed. They differ by design, often by three days.
  trading_date_pattern TEXT,
  -- Regex whose first capture group is the merchant/terminal number.
  merchant_pattern     TEXT,
  -- Lowest first. An acquirer with two shapes (Maybank's CR and DR card sales)
  -- gets two rows, and a broad rule must not shadow a narrow one.
  sort_order           INTEGER NOT NULL DEFAULT 100,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_bank_rule_field CHECK (match_field IN ('description', 'reference', 'both'))
);

CREATE INDEX acc_bank_rules_order ON scm.acc_bank_recognition_rules (is_active, sort_order, acquirer_code);

COMMENT ON TABLE scm.acc_bank_recognition_rules IS
  'How each acquirer''s money appears on a bank statement. Global, like the '
  'acquirer config: teaching the system a sixth bank is a row here, not a deploy.';

-- The four rules, seeded from the owner's OWN statements rather than from a
-- specification: the Maybank current account of Houzs Century
-- (ACCOUNTACTIVITYREPORT_564418610346.csv, 01-15 Aug 2026) and the Hong Leong
-- account of 2990 HOME (23600602788, 01-23 Jun 2026). Every pattern below was
-- run against those files before it was written down.
--
-- Seeded rather than left to a setup screen because the brief's rule is that
-- an acquirer without a recognition rule is an acquirer whose money reads as
-- 永远收不到 — the disease, not a configuration state to pass through.
--
-- ON CONFLICT is not needed: this table is created three statements above, so
-- it is empty. `WHERE EXISTS` keeps it honest against an acquirer a company has
-- not been given, since acquirer_code is a foreign key.
INSERT INTO scm.acc_bank_recognition_rules
  (acquirer_code, pattern, match_field, trading_date_pattern, merchant_pattern, sort_order, note)
SELECT v.code, v.pattern, v.field, v.dated, v.merchant, v.ord, v.note
FROM (VALUES
  -- Maybank writes both its card streams the same way apart from the CR/DR
  -- prefix, and the fee is the only difference: the CR stream credits the net,
  -- the DR stream credits the gross and takes the fee back on the same
  -- reference. One pattern covers both; the grouping rule handles the split.
  ('MBB',  'CARD SALES',                        'both',        'DATED\s*(\d{8})',    'M/?N\s*(\d+)', 10,
   'CR/CARD SALES MN <merchant> DATED <DDMMYYYY> credits the net; DR/CARD SALES M/N credits the gross and debits the fee on the same reference.'),
  -- Public Bank settles from another bank, so it arrives as an interbank GIRO
  -- credit advice and carries a sender name.
  ('PBB',  'PBB-PBCS',                          'both',        NULL,                 NULL,           20,
   'Sender "03999061714  PBB-PBCS AC 3". One advice can cover several trading days, so it carries no single trading date.'),
  -- AEON pays net like any acquirer; the instalment arrangement is between AEON
  -- and the customer and never reaches these books (owner, 2026-08-19).
  ('AEON', 'AEON CREDIT SERVICE',               'both',        NULL,                 NULL,           30,
   'Book Transfer Third AEON CREDIT SERVICE, reference MA…. Several distinct payouts can share one reference on one day.'),
  -- Hong Leong settles from Hong Leong into a Hong Leong account, so the money
  -- never leaves the bank: no interbank leg, and therefore NO SENDER. What
  -- identifies it is the reference, and the trading day is inside it.
  ('HLB',  'CA Credit Advice',                  'both',        'MERCHANT\s+(\d{8})', '(\d{9,})\s+MERCHANT', 40,
   'Blank sender is not a defect: an own-bank settlement has no interbank leg. Reference reassembles to "<merchant no>  MERCHANT <YYYYMMDD>", and that date is the TRADING day.')
) AS v(code, pattern, field, dated, merchant, ord, note)
WHERE EXISTS (SELECT 1 FROM scm.acc_acquirer_config c WHERE c.code = v.code);

-- 3. One uploaded statement.
CREATE TABLE scm.acc_bank_statements (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id           INTEGER NOT NULL,
  account_code         TEXT    NOT NULL,
  file_name            TEXT    NOT NULL,
  -- Same guard as the settlement batches: the same file twice is the same
  -- statement, and a second upload must lose rather than double the movements.
  file_hash            TEXT    NOT NULL,
  period_from          DATE,
  period_to            DATE,
  line_count           INTEGER NOT NULL DEFAULT 0,
  skipped_lines        INTEGER NOT NULL DEFAULT 0,
  in_sen               BIGINT  NOT NULL DEFAULT 0,
  out_sen              BIGINT  NOT NULL DEFAULT 0,
  -- What the FILE says its balances are, when it carries them. Kept as the
  -- statement's own claim, never as our answer: the reconciliation compares
  -- these against the ledger and the difference is the whole point.
  opening_balance_sen  BIGINT,
  closing_balance_sen  BIGINT,
  status               TEXT    NOT NULL DEFAULT 'OPEN',   -- OPEN | RECONCILED
  uploaded_by          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_bank_stmt_status CHECK (status IN ('OPEN', 'RECONCILED')),
  CONSTRAINT acc_bank_stmt_once   UNIQUE (company_id, file_hash)
);

CREATE INDEX acc_bank_statements_co ON scm.acc_bank_statements (company_id, account_code, period_from DESC);

-- 4. One MOVEMENT of that statement.
--
-- A movement, not a line: Maybank sometimes pays a batch as a credit with the
-- fee taken back as its own debit (owner: 偶尔会在 bank statement 显示进全额然后
-- 扣), and those two rows are one payout of RM 871.06. `charge_sen` is what was
-- taken back, and `line_no` points at the CREDIT so the operator can find it on
-- the page he is holding.
--
-- The joining rule is narrow on purpose and the owner's own file is why: three
-- separate AEON payouts share one reference on one day, so "same reference =
-- same movement" would invent a payout that never happened. Only ONE credit
-- plus the debits sharing its reference and date are ever joined.
CREATE TABLE scm.acc_bank_statement_lines (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement_id    BIGINT  NOT NULL REFERENCES scm.acc_bank_statements (id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL,
  line_no         INTEGER NOT NULL,
  booked_on       DATE    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  reference       TEXT,
  -- Signed: positive is money IN. One number, because a reconciliation adds
  -- them up and a two-column shape only invites the sign to go missing.
  amount_sen      BIGINT  NOT NULL,
  -- What the bank took back out of this credit, when it split it. 0 otherwise.
  charge_sen      BIGINT  NOT NULL DEFAULT 0,
  -- What the matcher made of it. PAYOUT means an acquirer settling a statement
  -- we have already reconciled; OTHER means the rest of banking life.
  kind            TEXT    NOT NULL DEFAULT 'OTHER',
  acquirer_code   TEXT,
  -- The trading day the bank names, which is not the day it paid.
  trading_date    DATE,
  merchant_no     TEXT,
  -- WHICH merchant statement the matcher decided this credit settles, when it
  -- could decide. Kept, because the alternative is to throw the decision away
  -- and make the screen guess it back from a list of candidates — which is a
  -- different answer: the first statement of that acquirer, not the one whose
  -- trading day and amount actually agreed. A suggestion, still confirmed by a
  -- person; nothing is booked off this column alone.
  matched_batch_id BIGINT REFERENCES scm.acc_settlement_batches (id) ON DELETE SET NULL,
  -- And when SEVERAL statements add up to it: [{batchId, amountSen}], oldest
  -- first. Public Bank pays three trading days with one advice, so a single
  -- matched_batch_id could not describe its ordinary payout.
  split            JSONB,
  -- OPEN until somebody decides; POSTED once its entry exists; IGNORED for a
  -- line that is genuinely none of our business.
  state           TEXT    NOT NULL DEFAULT 'OPEN',
  -- NOTE: no receipt_id column. One credit can pay SEVERAL merchant statements
  -- — Public Bank's advice of 10 Aug pays for trading on the 7th, 8th and 9th —
  -- so the link is on the receipt side (see the ALTER below) and a movement's
  -- receipts are however many it wrote. A single column here would have made
  -- the ordinary Public Bank payout unrecordable.
  posted_je_no    TEXT,
  posted_je_id    TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- PAYOUT_SPLIT: one credit paying SEVERAL reconciled reports — Public Bank's
  --   ordinary behaviour, one advice for three trading days.
  -- DUPLICATE: this exact movement was already recorded from another upload of
  --   an overlapping period. Not a payout to book and not ordinary banking, so
  --   it needs its own answer: without one, re-uploading a longer export of the
  --   same month reads as six unexplained credits.
  CONSTRAINT acc_bank_line_kind  CHECK (kind IN ('PAYOUT', 'PAYOUT_SPLIT', 'PAYOUT_UNSURE', 'PAYOUT_NO_BATCH', 'DUPLICATE', 'OTHER')),
  CONSTRAINT acc_bank_line_state CHECK (state IN ('OPEN', 'POSTED', 'IGNORED')),
  CONSTRAINT acc_bank_line_charge CHECK (charge_sen >= 0),
  CONSTRAINT acc_bank_line_once  UNIQUE (statement_id, line_no)
);

CREATE INDEX acc_bank_lines_stmt  ON scm.acc_bank_statement_lines (statement_id, line_no);
CREATE INDEX acc_bank_lines_state ON scm.acc_bank_statement_lines (company_id, state, booked_on);

-- 4b. Which bank movement wrote a settlement receipt.
--
-- On the RECEIPT, not on the line, because the relationship is one-to-MANY in
-- that direction: one credit can pay several merchant statements, and each
-- statement's share is its own receipt with its own journal entry. Public Bank
-- pays exactly this way — one advice of 10 Aug for trading on the 7th, 8th and
-- 9th (migration 0304's header) — so it is the ordinary case, not an edge one.
--
-- NULL for a receipt keyed in by hand on the money screen, which is still a
-- legitimate way to record a payout on a day the file has not arrived.
ALTER TABLE scm.acc_settlement_receipts
  ADD COLUMN bank_line_id BIGINT REFERENCES scm.acc_bank_statement_lines (id) ON DELETE SET NULL;

CREATE INDEX acc_settlement_receipts_bank_line
  ON scm.acc_settlement_receipts (bank_line_id) WHERE bank_line_id IS NOT NULL;

COMMENT ON COLUMN scm.acc_settlement_receipts.bank_line_id IS
  'The bank movement this credit was read from, when it came off a statement '
  'rather than being keyed in. Several receipts can share one movement: one '
  'advice often pays several trading days at once.';

-- 5. Which LEDGER entries a bank movement covers.
--
-- A separate table for the same reason layer 3 has one: one bank credit can
-- cover several entries (a customer paying three invoices in one transfer), and
-- because the second-layer guarantee belongs in the database —
--
--   acc_bank_je_once — a journal entry may be reconciled by ONE bank movement.
--   A second statement line claiming the same entry loses the insert rather
--   than quietly reconciling the same money twice.
CREATE TABLE scm.acc_bank_statement_matches (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_line_id     BIGINT  NOT NULL REFERENCES scm.acc_bank_statement_lines (id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL,
  -- The journal ENTRY this movement accounts for, keyed by its NUMBER.
  --
  -- je_no rather than the entry's uuid, and deliberately: scm.v_gl_entries is
  -- the one posted-ledger read every balance in this system already goes
  -- through, and it exposes je_no and not the id. Keying on what the view
  -- actually carries keeps this table joinable to the ledger without recreating
  -- a view the GL export depends on. je_no is minted per company+month behind a
  -- unique index (acc/engine.ts), so it identifies an entry exactly.
  je_no            TEXT    NOT NULL,
  amount_sen       BIGINT  NOT NULL,
  -- ref | amount+date | manual — the same vocabulary layer 3 uses, so the two
  -- screens can never mean different things by the same word.
  match_reason     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_bank_match_reason CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual')),
  CONSTRAINT acc_bank_je_once UNIQUE (company_id, je_no)
);

CREATE INDEX acc_bank_matches_line ON scm.acc_bank_statement_matches (bank_line_id);

COMMENT ON TABLE scm.acc_bank_statement_matches IS
  'Which ledger entries a bank movement accounts for. The unique on (company, '
  'je_no) is the guarantee that one entry cannot be reconciled twice.';
