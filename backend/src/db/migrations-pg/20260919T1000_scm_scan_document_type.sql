-- ----------------------------------------------------------------------------
-- 20260919T1000 — a document-type dimension on the scan pipeline tables.
--
-- WHY. The SO scanner (scm.scan_jobs / scm.so_scan_samples / scm.so_scan_rules)
-- becomes the shared base for scanning supplier Delivery Orders into DRAFT
-- Goods Receipts and supplier Invoices into DRAFT Purchase Invoices
-- (tasks/PLAN-ocr-scan-gr-pi.md, slice 1 of 5). This slice ONLY adds the
-- column so the pipeline can carry the type; it ships no GR/PI behaviour. The
-- SO path threads document_type='SO' explicitly, so SO stays byte-identical.
--
-- WHAT.
--   scm.scan_jobs
--     document_type   'SO' | 'GR' | 'PI', NOT NULL DEFAULT 'SO'. Existing rows
--                     are all SO — the NOT NULL default fills them.
--     linked_doc_no   the generic "the document this scan produced" column.
--                     so_doc_no stays (everything that reads it keeps working);
--                     the SO path now writes BOTH, and existing rows are
--                     back-filled linked_doc_no = so_doc_no below. GR/PI rows
--                     will write linked_doc_no only.
--   scm.so_scan_samples  document_type NOT NULL DEFAULT 'SO' — one learning
--                        pool, partitioned by type so few-shot injection stays
--                        per document type.
--   scm.so_scan_rules    document_type NOT NULL DEFAULT 'SO'. NOTE: the PK is
--                        (salesperson); this slice does NOT widen it. Per-doc
--                        rules, if ever needed, come with their own migration.
--
-- The linked_doc_no back-fill copies an EXISTING column into the new generic
-- one (schema consistency, not business data): it writes no new facts, only
-- mirrors so_doc_no that the SO path already minted.
--
-- Postgres-only — SCM has no D1 twin (precedent: 0066/0067; an empty D1 stub
-- breaks the D1 test runner). ADDITIVE + idempotent. Outer BEGIN;/COMMIT;
-- omitted — pg-migrate.mjs wraps the whole file in one transaction.
--
-- REVERSAL:
--   ALTER TABLE scm.scan_jobs        DROP COLUMN IF EXISTS document_type;
--   ALTER TABLE scm.scan_jobs        DROP COLUMN IF EXISTS linked_doc_no;
--   ALTER TABLE scm.so_scan_samples  DROP COLUMN IF EXISTS document_type;
--   ALTER TABLE scm.so_scan_rules    DROP COLUMN IF EXISTS document_type;
--   DROP INDEX IF EXISTS scm.scan_jobs_document_type_idx;
--   (All additive. Dropping them reverts to the SO-only shape; so_doc_no, which
--   was never touched, still carries every SO doc number.)
-- ----------------------------------------------------------------------------

ALTER TABLE scm.scan_jobs
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'SO',
  ADD COLUMN IF NOT EXISTS linked_doc_no text;

COMMENT ON COLUMN scm.scan_jobs.document_type IS
  'Which document this scan produces: SO (default) | GR | PI. SO threads this explicitly so SO behaviour is unchanged (20260919T1000).';
COMMENT ON COLUMN scm.scan_jobs.linked_doc_no IS
  'Generic doc_no this scan produced. SO writes both this and so_doc_no; GR/PI write only this. Back-filled from so_doc_no for pre-existing SO rows (20260919T1000).';

-- Mirror so_doc_no into the new generic column for rows that predate it, so a
-- reader of linked_doc_no sees the SO scans that already completed.
UPDATE scm.scan_jobs
  SET linked_doc_no = so_doc_no
  WHERE linked_doc_no IS NULL AND so_doc_no IS NOT NULL;

-- document_type is the natural filter once GR/PI rows share the table.
CREATE INDEX IF NOT EXISTS scan_jobs_document_type_idx
  ON scm.scan_jobs (document_type);

ALTER TABLE scm.so_scan_samples
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'SO';

COMMENT ON COLUMN scm.so_scan_samples.document_type IS
  'Which document type this learning sample belongs to: SO (default) | GR | PI. One pool, partitioned by type for few-shot injection (20260919T1000).';

ALTER TABLE scm.so_scan_rules
  ADD COLUMN IF NOT EXISTS document_type text NOT NULL DEFAULT 'SO';

COMMENT ON COLUMN scm.so_scan_rules.document_type IS
  'Which document type this distilled rule set belongs to: SO (default) | GR | PI. PK is still (salesperson); not widened in this slice (20260919T1000).';
