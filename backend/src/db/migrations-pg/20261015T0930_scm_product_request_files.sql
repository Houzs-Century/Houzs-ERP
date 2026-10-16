-- 20261015T0930_scm_product_request_files.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.product_request_files;
--   Revert the code first (routes/product-requests.ts binds the four file
--   handlers on this table). The requests stay — only the index of their files
--   goes; the bytes under product-request-files/<company>/<request>/ in the
--   SLIPS R2 bucket are not SQL's to remove (list with `wrangler r2 object
--   list`, delete by key, or leave them orphaned — nothing reads a key without
--   its index row).
--   GRANTS: none to re-apply — like scm.acc_payment_request_files, the table
--   rides the scm schema's default privileges (service_role); this file grants
--   nothing, so the reverse re-grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its index; no existing row is written or altered.
--
-- WHY (owner 2026-10-15: 需要可以 attach 文件功能): a product request carries
-- its evidence — the supplier's quotation, photos of the piece, a drawing —
-- the same way a payment request carries its bill. Same shape as
-- scm.acc_payment_request_files (20260930T0600), fed to the ONE file factory
-- (scm/lib/doc-files.ts): file_key is the R2 object, sort_no the attach order.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.product_request_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  request_id  uuid        NOT NULL REFERENCES scm.product_requests(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_product_request_files_request ON scm.product_request_files (company_id, request_id, sort_no);
