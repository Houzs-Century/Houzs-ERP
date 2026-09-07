-- 20260907T0715_announcement_files.sql
-- REVERSAL: DROP INDEX IF EXISTS public.idx_announcement_files_ann; DROP TABLE IF EXISTS public.announcement_files;
-- Verified against: staging (minnapsemfzjmtvnnvdd) through the normal
--           migrate-before-deploy path on merge; prod (anogrigyjbduyzclzjgn)
--           carries the same announcements shape (0058 … 20260906T1509).
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   One new table, no change to any existing one. announcements.attachments
--   (the JSON manifest the readers render) stays the source of what is
--   attached; this table is the LOG of who attached / removed which file and
--   when. Nothing that shipped before reads it, and every reader of it
--   tolerates the table being absent (the D1 test mirrors, the merge-to-
--   migrate window).
--
-- WHY (owner, 2026-09-06, "标准化编号与文档管理" — 操作日志 / 强制附件):
--   The document-management spec asks for a record of who uploaded which
--   attachment, and for an attachment to be mandatory per document type
--   (document_types.attachment_required, mig 20260906T1417) before a document
--   is submitted. services/announcementFiles.ts keeps this table in step with
--   the manifest on every create / edit (a key that appears is a row with the
--   actor as uploader; a key that disappears keeps its row with removed_by /
--   removed_at), and the same service answers the "attachment required"
--   gate on submit.
CREATE TABLE IF NOT EXISTS public.announcement_files (
  id bigserial PRIMARY KEY,
  announcement_id text NOT NULL,
  r2_key text NOT NULL,
  name text,
  mime text,
  size integer,
  uploaded_by integer,
  uploaded_at text NOT NULL,
  removed_by integer,
  removed_at text,
  UNIQUE (announcement_id, r2_key)
);
CREATE INDEX IF NOT EXISTS idx_announcement_files_ann
  ON public.announcement_files (announcement_id);
