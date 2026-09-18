-- 20260911T1000_acc_bank_match_group.sql
--
-- REVERSAL: put the one-entry-one-line unique back —
--   ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_je_line_once;
--   ALTER TABLE scm.acc_bank_statement_matches ADD CONSTRAINT acc_bank_je_once UNIQUE (company_id, je_no);
--   That ADD fails while any entry is matched to two movements; undo those
--   groups on the bank screen first (each undo reopens the whole group).
--
-- WHAT THIS IS. One journal entry can be several bank movements: 2990's
-- receipt OR-2604-001 is RM 39,000 from HOUZS VENTURE HOLDING, and Hong Leong
-- shows it as two transfers, RM 29,000 and RM 10,000. And one bank movement can
-- be several entries: one transfer paying two vouchers. The unique on
-- (company, je_no) — "one entry cannot be reconciled twice" — made the first
-- shape impossible: the second movement to name the entry lost (owner,
-- 2026-09-11: 他对应的是这两笔，你应该开发让我自由选).
--
-- The guarantee moves, it does not go. The index now says one entry is matched
-- to one movement AT MOST ONCE; that an entry is not accounted for twice is
-- the route's job (backend/src/scm/routes/accounting-bank.ts,
-- bankLinesMatchGroup and bankLineMatch): an entry any POSTED movement already
-- claims is refused by name, and a group posts only when the movements and the
-- entries add up to the sen. Undo of any movement in a group reopens the whole
-- group, so a half-claimed entry is not a state the table can hold.

ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_je_once;
ALTER TABLE scm.acc_bank_statement_matches
  ADD CONSTRAINT acc_bank_je_line_once UNIQUE (company_id, je_no, bank_line_id);

COMMENT ON TABLE scm.acc_bank_statement_matches IS
  'Which ledger entries a bank movement accounts for. Several movements may share one '
  'entry and one movement may carry several entries, as long as the two sides add up; '
  'the unique on (company, je_no, bank_line_id) keeps a pair from being written twice, '
  'and the route refuses an entry another posted movement already claims.';
