-- 20261001T2355_acc_credit_note_files.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_credit_note_files; — the bytes it indexed, under credit-note-files/<company>/<note>/ in the SLIPS R2 bucket, are not SQL's to remove: list them with `wrangler r2 object list` and delete by key, or leave them orphaned (nothing reads a key without its index row).
--   GRANTS: none to re-apply — like scm.acc_ap_invoice_files (20260906T2100), this table rides the scm schema's default privileges (service_role); this file grants nothing, so the reverse re-grants nothing.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the table, its FK and index read back in the PR body.
--
-- A credit note's paper LIVES with the credit note, the way a supplier's bill
-- lives with its AP invoice (owner 2026-10-01: supplier 给我 cn，我要做 ocr for
-- cn). The scanned supplier credit note is attached to the Supplier Credit Note
-- it became; any note may carry evidence.
--
-- One row per stored file; the bytes sit in the SLIPS R2 bucket under
-- credit-note-files/<company>/<note>/<uuid>.<ext>. Delete is refused once the
-- note is POSTED (evidence locks with the document); a CANCELLED note takes no
-- more. Same shape as scm.acc_ap_invoice_files on purpose, including `kind`
-- (20261001T1900) — the handlers are one factory (backend/src/scm/lib/doc-files.ts).
--
-- Safe against production: one new empty table + one index; no row written,
-- nothing altered.

CREATE TABLE IF NOT EXISTS scm.acc_credit_note_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  note_id     uuid        NOT NULL REFERENCES scm.acc_credit_notes(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  kind        text        NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'official')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_acc_credit_note_files_note ON scm.acc_credit_note_files (note_id);
