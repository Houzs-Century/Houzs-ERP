-- 20261127T1700_acc_settlement_terminal_id.sql
--
-- WHY. Owner 2026-11-27: every merchant report names the card terminal of each
-- line, and upload threw it away (「我上传的merchant report 应该是有terminal id
-- 的」, then 「对，往后上传后都要保存起来」). Checked on 53 uploaded files, all
-- banks: PBB prints a TID column, Maybank a Terminal No. column, GHL a
-- terminal_id column, and Hong Leong and AEON a TERMINAL ID line heading each
-- terminal's lines.
--
-- scm.acc_settlement_rows.terminal_id — the terminal as the report prints it,
-- kept by the upload from now on (acc/settlement-parse.ts). Lines uploaded
-- before this stay NULL: the raw files were never kept, so there is nothing to
-- read them back from.
--
-- MULTI-COMPANY. A column on a company-scoped table; nothing new to scope.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.acc_settlement_rows DROP COLUMN IF EXISTS terminal_id;

ALTER TABLE scm.acc_settlement_rows
  ADD COLUMN IF NOT EXISTS terminal_id TEXT NULL;

COMMENT ON COLUMN scm.acc_settlement_rows.terminal_id IS
  'The card terminal the merchant report names for this line (its TID / Terminal No. / terminal_id column, or the TERMINAL ID line heading its block). NULL when the report names none, and for lines uploaded before 2026-11-27.';
