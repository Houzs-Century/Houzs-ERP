-- 20260906T2100_acc_ap_invoice_files.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_ap_invoice_files; — the bytes it indexed, under ap-invoice-files/<company>/<invoice>/ in the SLIPS R2 bucket, are not SQL's to remove: list them with `wrangler r2 object list` and delete by key, or leave them orphaned (nothing reads a key without its index row).
--   GRANTS: none to re-apply — like 0352's scm.acc_pv_files, this table rides the scm schema's default privileges (service_role); this file grants nothing, so the reverse re-grants nothing.
--
-- AP invoice attachments — the supplier's bill LIVES with the AP invoice, the
-- way the scanned bill lives with its voucher (0352). Owner 2026-09-06, on
-- being told the AP invoice had neither OCR nor files: 做,附件也一起做,
-- bundle 也带上.
--
-- One row per stored file; the bytes sit in the SLIPS R2 bucket under
-- ap-invoice-files/<company>/<invoice>/<uuid>.<ext>; sort_no = attach order =
-- the order the AP Payment's print bundle appends them after the voucher's
-- own files (routes/pv-files.ts print-bundle, one paid bill after another).
-- Delete is refused once the bill is POSTED — evidence locks with the
-- document (the PV locks at CHECKED; an AP invoice has no check layer, so
-- the ledger is its lock). Same shape as scm.acc_pv_files on purpose: the
-- handlers are one factory (backend/src/scm/lib/doc-files.ts) fed two specs.
--
-- Safe against production: one new empty table + one index; no row written,
-- nothing altered.
--
-- Verified against: staging apply via apply_migration (table + index present,
-- FK to scm.ap_invoices ON DELETE CASCADE — probe in the PR body) and
-- backend/tests/apInvoiceFiles.test.ts (upload/list/stream/delete on the fake
-- R2 binding + the bundle carrying a paid bill's files).

CREATE TABLE IF NOT EXISTS scm.acc_ap_invoice_files (
  id            uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    bigint      NOT NULL,
  ap_invoice_id uuid        NOT NULL REFERENCES scm.ap_invoices(id) ON DELETE CASCADE,
  file_key      text        NOT NULL UNIQUE,
  file_name     text        NOT NULL,
  mime          text        NOT NULL,
  size_bytes    bigint      NOT NULL,
  sort_no       int         NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text
);
CREATE INDEX IF NOT EXISTS idx_acc_ap_invoice_files_invoice ON scm.acc_ap_invoice_files (ap_invoice_id);
