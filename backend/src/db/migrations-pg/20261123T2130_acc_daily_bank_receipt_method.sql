-- 20261123T2130_acc_daily_bank_receipt_method.sql
--
-- WHY. Owner 2026-11-23, sending a table of banks by method (Online, Cash, Cheque
-- and the card terminals): 「不能做成这样的表格给我keyin income？」. The cash book's
-- receipts are now keyed as a grid — per bank and day, one total per method — so a
-- receipt carries the method it came by. 'online', 'cash', 'cheque', or
-- 'card:<acquirer code>' (Settlement Setup's terminals). NULL = a receipt typed
-- with a note before the grid; those stay as they are.
--
-- One live amount per bank, day and method: the grid's cell. A deleted receipt
-- (deleted_at set) does not count, so a cell cleared and typed again is a new row
-- and the old one stays for the trail.
--
-- Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.acc_daily_bank_receipts_one_cell;
--   ALTER TABLE scm.acc_daily_bank_receipts DROP COLUMN IF EXISTS method;
--   Revert the code first. Dropping the column loses which method each grid receipt
--   came by; the receipts, their amounts and their notes (the method's name) stay.

ALTER TABLE scm.acc_daily_bank_receipts ADD COLUMN IF NOT EXISTS method TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS acc_daily_bank_receipts_one_cell
  ON scm.acc_daily_bank_receipts (company_id, account_code, receipt_date, method)
  WHERE deleted_at IS NULL AND method IS NOT NULL;

COMMENT ON COLUMN scm.acc_daily_bank_receipts.method IS
  'How the money came: online, cash, cheque or card:<acquirer code>; one live row per bank, day and method. NULL = typed with a note.';

NOTIFY pgrst, 'reload schema';
