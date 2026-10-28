-- 062_idea_archive.sql
--
-- Soft-delete column on innovations + suggestions. Mirrors the
-- archive pattern already used by votes, idea_attachments, and
-- idea_comments. Owners and admins can archive a post; archived rows
-- drop out of all list / detail queries but stay in the database for
-- audit history (votes / comments / points already-awarded all remain
-- referentially intact).

ALTER TABLE innovations ADD COLUMN archived_at TEXT;
ALTER TABLE suggestions ADD COLUMN archived_at TEXT;

CREATE INDEX idx_innovations_archived ON innovations(archived_at);
CREATE INDEX idx_suggestions_archived ON suggestions(archived_at);
