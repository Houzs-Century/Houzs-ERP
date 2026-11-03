-- 20261103T1900_acc_settlement_row_not_this.sql
-- "Not this" on a merchant report line (owner 2026-11-03, batch 3 d2: 「可以」).
-- The machine matches an UNCONFIRMED line to a payment by its reference — at
-- upload, or when a merchant's open lines are matched again — and a person can
-- now say it is not that sale: the line's links are released and the line goes
-- back to be chosen. This column remembers the payments a person turned down
-- for the line, as "SOPAY:<id>" / "SIPAY:<id>" keys, so neither the report's
-- suggestion, "Confirm all" nor a rematch hands the same payment back to it.
-- A person may still pick it by hand; the memory steers the machine only.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- column on scm.acc_settlement_rows, every existing row reading '[]' (nothing
-- turned down). NOT NULL with a constant default is a catalogue-only change; no
-- row is rewritten. Nothing posts.
--
-- REVERSAL:
--   Revert the code first (acc/settlement.ts, acc/settlement-rematch.ts and
--   routes/accounting-settlement.ts read this column).
--   ALTER TABLE scm.acc_settlement_rows DROP COLUMN IF EXISTS not_this;
--   GRANTS: none — a column on an existing table rides that table's grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_settlement_rows
  ADD COLUMN IF NOT EXISTS not_this jsonb NOT NULL DEFAULT '[]'::jsonb;
