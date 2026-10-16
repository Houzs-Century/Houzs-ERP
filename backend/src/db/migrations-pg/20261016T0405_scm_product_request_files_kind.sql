-- 20261016T0405_scm_product_request_files_kind.sql
-- REVERSAL: ALTER TABLE scm.product_request_files DROP COLUMN IF EXISTS kind;
--   Nothing else to revert: the column is read by the shared file factory's
--   list (scm/lib/doc-files.ts) and never written by a product request, so
--   dropping it only breaks that list again. GRANTS: none to re-apply — a
--   column rides its table's grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one column
-- with a default on scm.product_request_files; every existing row (5 on
-- production at the time of writing) reads 'bill'. No row is written.
--
-- WHY (owner 2026-10-16: 这个我上传不到文件): the file factory every document's
-- evidence rides lists `kind` (20261001T1900 added it to the three money
-- documents' file tables for the official-invoice follow-up). The product
-- request's file table (20261015T0930) was created without it, so every
-- upload landed but the list read 500 and the card showed "0 files". Same
-- column, same default and check, so the factory reads all five tables alike.

SET search_path = public, scm;

ALTER TABLE scm.product_request_files
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bill' CHECK (kind IN ('bill', 'official'));
