-- 20260908T0620_scm_autocount_outbox_archive.sql
--
-- WHAT THIS CHANGES: two nullable columns and one partial index on
-- scm.autocount_outbox. No row is written, no row is deleted, nothing existing
-- is read differently by anything that has not been changed to look — a NULL
-- archived_at is exactly today's behaviour on every one of the rows already
-- there.
--
-- WHY. The queue is append-only and one document accumulates a row per
-- operation forever, so a document whose work is finished never leaves the
-- AutoCount Sync page. Measured against production on 2026-09-08 (read-only
-- DSN): Houzs Century's whole queue was 32 rows across THREE documents —
-- HC-SO-013361, HC-SO-013393 and HC-SO-013394, every one of them an old
-- write-back test, every one of them in the account book, with the page's own
-- banner reading "Everything is in AutoCount. Nothing is waiting and nothing
-- was refused." A screen whose entire job is to show what still needs somebody
-- had nothing on it but finished work. The owner asked twice for it to be
-- cleared.
--
-- WHY NOT DELETE. This table's own COMMENT forbids it — "Never delete rows:
-- this is the audit trail of what the ERP told AutoCount" — and the owner's
-- standing rule for the whole ERP is never delete, only cancel. The audit
-- trail is the point of the table; retiring a row from a SCREEN is a different
-- act from destroying the record of what was sent, and this keeps them
-- different.
--
-- WHY NOT A NOTE ON last_error, WHICH IS THE OBVIOUS CHEAP ANSWER. It is worse
-- than doing nothing. `isRequeuedNote` (scm/lib/autocount-outbox-status.ts) is
-- a PREFIX test, deliberately, so that a row whose own message quotes the
-- marker mid-string still reads as an open refusal. Prepending a second marker
-- to a re-queued row's note therefore stops it classifying as `requeued` and
-- pushes it back onto the "Not accepted" tab — the exact opposite of what was
-- asked. A COLUMN cannot do that: nothing that classifies a row reads
-- archived_at, so every verdict the page already reaches is unchanged.
--
-- WHY NOT A NEW `status`. 0277's CHECK admits four values and each of them is
-- a claim about what AUTOCOUNT did. "A person has finished looking at this" is
-- not one of those claims, and squeezing it in would make `sent` mean two
-- things. Same argument as `requeued`, which is a derived STATE for the same
-- reason and is likewise not a status.
--
-- REVERSIBLE BY CONSTRUCTION: clearing archived_at puts the row back on the
-- page exactly as it was. That is the "restore" the page offers.
--
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.autocount_outbox_live_idx;
--   ALTER TABLE scm.autocount_outbox DROP COLUMN IF EXISTS archived_by;
--   ALTER TABLE scm.autocount_outbox DROP COLUMN IF EXISTS archived_at;
--   COMMENT ON TABLE scm.autocount_outbox IS 'ERP -> AutoCount write-back queue. One row per intended AutoCount operation. Drained by the */5 cron (scm/lib/autocount-outbox.drainAutoCountOutbox) when scm.app_config key scm.autocount_writeback is on. Never delete rows: this is the audit trail of what the ERP told AutoCount.';
-- Dropping the columns loses only WHO cleared WHAT and WHEN; no send, no
-- reason and no document number lives in them, so the audit trail this table
-- exists for is untouched by the reversal. Every retired row comes back onto
-- the page, which is the state before this migration.

ALTER TABLE scm.autocount_outbox ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE scm.autocount_outbox ADD COLUMN IF NOT EXISTS archived_by bigint;

COMMENT ON COLUMN scm.autocount_outbox.archived_at IS
  'When a person retired this row from the AutoCount Sync page. NULL = on the page. Says NOTHING about whether AutoCount took the document: status and last_error are the only record of that and are never written by an archive. Clearing this column restores the row.';

COMMENT ON COLUMN scm.autocount_outbox.archived_by IS
  'Who retired the row. NULL when archived_at is NULL, and also when the acting user could not be resolved -- the archive still proceeds, because a missing name is not a reason to leave a finished document on the page.';

-- The page's default read is "everything NOT archived", which is a scan over
-- the company's live rows. Partial on archived_at IS NULL so the index stays
-- the size of what is on screen rather than of the history, the same reasoning
-- as 0277's own autocount_outbox_pending_idx.
CREATE INDEX IF NOT EXISTS autocount_outbox_live_idx
  ON scm.autocount_outbox (company_id, created_at DESC)
  WHERE archived_at IS NULL;

-- 0277's table comment, extended rather than replaced: the "never delete"
-- sentence is the reason this column exists and must not be lost when someone
-- reads the table's own documentation to find out what may be done to it.
COMMENT ON TABLE scm.autocount_outbox IS
  'ERP -> AutoCount write-back queue. One row per intended AutoCount operation. Drained by the */5 cron (scm/lib/autocount-outbox.drainAutoCountOutbox) when scm.app_config key scm.autocount_writeback is on. Never delete rows: this is the audit trail of what the ERP told AutoCount. To take a FINISHED document off the AutoCount Sync page, set archived_at instead -- it hides the row from the page and changes nothing about what was sent.';
