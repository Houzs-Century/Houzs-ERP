-- 0352: PV attachments — the scanned bill finally LIVES with its voucher
-- (owner 2026-09-03, wanting print-with-evidence: 我希望可以 print pv
-- include ocr 的文件一起 — and the audit before it: the scan flow READ the
-- bill but never kept it, so there was nothing to attach).
--
-- One row per stored file. The bytes live in the SLIPS R2 bucket under
-- pv-files/<company>/<pv>/<uuid>.<ext>; this table is the index the detail
-- page lists and the printer walks (sort_no = attach order, which is also
-- the print order: PV page first, then its files). Deletes are blocked once
-- the voucher is CHECKED — evidence locks with the document (prepare 还可以
-- 改，然后 checked 的人就不可以改了, the owner's own four-layer rule).
--
-- Verified against: backend/tests/pvFiles.test.ts (upload/list/stream/delete
-- against a fake R2 binding) and the staging rehearsal, which applies this
-- before any prod deploy runs it.
-- Reversal: DROP TABLE scm.acc_pv_files;

CREATE TABLE IF NOT EXISTS scm.acc_pv_files (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id bigint      NOT NULL,
  pv_id      uuid        NOT NULL REFERENCES scm.payment_vouchers(id) ON DELETE CASCADE,
  file_key   text        NOT NULL UNIQUE,
  file_name  text        NOT NULL,
  mime       text        NOT NULL,
  size_bytes bigint      NOT NULL,
  sort_no    int         NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);
CREATE INDEX IF NOT EXISTS idx_acc_pv_files_pv ON scm.acc_pv_files (pv_id);
