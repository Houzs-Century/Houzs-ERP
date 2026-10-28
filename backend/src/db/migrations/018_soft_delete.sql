-- 018_soft_delete.sql
-- Soft-delete (archive) pattern for the ASSR workflow. Each table
-- picks up two columns:
--   archived_at : datetime when archived (NULL means active)
--   archived_by : staff user_id who archived it (nullable for
--                 customer-self-archive cases)
--
-- Queries filter `WHERE archived_at IS NULL` by default. Staff can
-- pass ?include_archived=1 to see archived rows in management
-- contexts. No row is ever physically deleted — the audit trail is
-- preserved.

ALTER TABLE assr_cases       ADD COLUMN archived_at TEXT;
ALTER TABLE assr_cases       ADD COLUMN archived_by INTEGER;
ALTER TABLE assr_logistics   ADD COLUMN archived_at TEXT;
ALTER TABLE assr_logistics   ADD COLUMN archived_by INTEGER;
ALTER TABLE assr_attachments ADD COLUMN archived_at TEXT;
ALTER TABLE assr_attachments ADD COLUMN archived_by INTEGER;
ALTER TABLE assr_activity    ADD COLUMN archived_at TEXT;
ALTER TABLE assr_activity    ADD COLUMN archived_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_assr_cases_archived       ON assr_cases(archived_at);
CREATE INDEX IF NOT EXISTS idx_assr_logistics_archived   ON assr_logistics(archived_at);
CREATE INDEX IF NOT EXISTS idx_assr_attachments_archived ON assr_attachments(archived_at);
CREATE INDEX IF NOT EXISTS idx_assr_activity_archived    ON assr_activity(archived_at);
