-- Which BUILD of AcSyncService answered this row.
--
-- THE QUESTION THIS EXISTS TO END. "Is the host running a build new enough for
-- <feature>" has been UNKNOWN at every point where it mattered, and the cost is
-- not the not-knowing: it is that a feature the host does not have looks exactly
-- like a feature that ran and found nothing. The name-mismatch report is the
-- worked example — `mismatches` is empty both when the host compared the names
-- and agreed, and when the host is too old to compare at all
-- (docs/generated/autocount-coverage.md says so in as many words).
--
-- /health has answered `builtAt` and `mvid` for a while; nothing stored either,
-- so the answer expired the moment the terminal scrolled. The drain reads it
-- once per sweep and stamps it on every row it dispatches, which makes two
-- different questions a SELECT instead of a memory:
--
--   what is the host running NOW      -> the newest non-null row
--   what refused THIS row, a year ago -> that row's own columns
--
-- WHY ON THE ROW rather than one current-state key in scm.app_config: a single
-- key answers only the first question, and the second is the one that gets
-- asked during an incident. The table is already the audit record of what the
-- ERP told AutoCount and what it answered; the build that answered belongs in
-- the same place. docs/autocount-sync-reasons.md section 5 proposed exactly
-- this, as two columns stamped by the drain.
--
-- NULL is a real answer and is left meaning what it means: the row was
-- dispatched before this column existed, or /health could not be read on that
-- sweep. Neither is "the host is fine", and neither is backfillable -- the
-- build that answered a row in the past is not recoverable from anywhere.
--
-- REVERSAL: ALTER TABLE scm.autocount_outbox DROP COLUMN host_built_at, DROP COLUMN host_mvid;
--   Safe: both columns are additive, nullable, written only by the drain and
--   read only by reports. Nothing joins on them and no constraint depends on
--   them, so dropping them loses the diagnostic and nothing else.

ALTER TABLE scm.autocount_outbox
  ADD COLUMN IF NOT EXISTS host_built_at timestamptz,
  ADD COLUMN IF NOT EXISTS host_mvid     text;

COMMENT ON COLUMN scm.autocount_outbox.host_built_at IS
  'AcSyncService /health builtAt at the moment this row was dispatched. NULL = dispatched before this column existed, or /health was unreadable on that sweep. Never backfillable.';
COMMENT ON COLUMN scm.autocount_outbox.host_mvid IS
  'AcSyncService /health mvid (module version id, unique per COMPILATION) at dispatch. Two rows with the same mvid were answered by the same bytes.';
