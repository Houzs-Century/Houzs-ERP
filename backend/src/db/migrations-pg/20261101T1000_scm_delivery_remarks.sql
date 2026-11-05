-- Last Mile dispatch / customer-service REMARKS — a thread of notes per sales
-- order, shown and written in the Last Mile order drawer (owner 2026-11-01,
-- phase 3). SHARED (everyone on the board sees it), so a table, not browser
-- state. Keyed by so_doc_no, which is globally unique across companies (same as
-- delivery_planning_row_marks.row_key), so it needs no company column. The
-- author is snapshotted (id + name at write time) so the thread still reads
-- "by <name>" after a staff rename.
-- REVERSAL: DROP TABLE IF EXISTS scm.delivery_remarks;
CREATE TABLE IF NOT EXISTS scm.delivery_remarks (
  id bigserial PRIMARY KEY,
  so_doc_no text NOT NULL,
  body text NOT NULL,
  author_id text,
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_remarks_so ON scm.delivery_remarks (so_doc_no, created_at);
