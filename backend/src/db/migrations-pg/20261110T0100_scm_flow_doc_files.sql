-- 20261110T0100_scm_flow_doc_files.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.grn_files, scm.purchase_invoice_files, scm.delivery_return_files, scm.purchase_return_files; — the bytes they indexed, under grn-files/ purchase-invoice-files/ delivery-return-files/ purchase-return-files/ <company>/<doc>/ in the SLIPS R2 bucket, are not SQL's to remove: list them with `wrangler r2 object list` and delete by key, or leave them orphaned (nothing reads a key without its index row).
--   GRANTS: none to re-apply — like scm.acc_credit_note_files (20261001T2355), these tables ride the scm schema's default privileges (service_role); this file grants nothing, so the reverse re-grants nothing.
-- Verified against: NOT YET APPLIED anywhere. Apply to staging first and read the four tables back; the PR stays open until then.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- Files on the receiving and return documents (backlog A3, sister Conts-ERP#278):
-- the supplier's DO on its Goods Received, the invoice scan on its Purchase
-- Invoice, damage photos on a Delivery Return or a Purchase Return. One index
-- table per document, the same shape as scm.acc_credit_note_files, because the
-- handlers are the one factory (backend/src/scm/lib/doc-files.ts) and a real FK
-- per document is what makes a row impossible to point at the wrong kind of
-- document. `kind` is read by the factory's list (docFilesTablesCarryKind.test.ts);
-- nothing here distinguishes kinds of file, so it holds one value.
--
-- Safe against production: four new empty tables + four indexes; no row written,
-- nothing existing altered.

CREATE TABLE IF NOT EXISTS scm.grn_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  grn_id      uuid        NOT NULL REFERENCES scm.grns(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  kind        text        NOT NULL DEFAULT 'file' CHECK (kind = 'file'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_grn_files_doc ON scm.grn_files (grn_id);

CREATE TABLE IF NOT EXISTS scm.purchase_invoice_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  purchase_invoice_id uuid        NOT NULL REFERENCES scm.purchase_invoices(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  kind        text        NOT NULL DEFAULT 'file' CHECK (kind = 'file'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_purchase_invoice_files_doc ON scm.purchase_invoice_files (purchase_invoice_id);

CREATE TABLE IF NOT EXISTS scm.delivery_return_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  delivery_return_id uuid        NOT NULL REFERENCES scm.delivery_returns(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  kind        text        NOT NULL DEFAULT 'file' CHECK (kind = 'file'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_delivery_return_files_doc ON scm.delivery_return_files (delivery_return_id);

CREATE TABLE IF NOT EXISTS scm.purchase_return_files (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL,
  purchase_return_id uuid        NOT NULL REFERENCES scm.purchase_returns(id) ON DELETE CASCADE,
  file_key    text        NOT NULL UNIQUE,
  file_name   text        NOT NULL,
  mime        text        NOT NULL,
  size_bytes  bigint      NOT NULL,
  sort_no     int         NOT NULL DEFAULT 1,
  kind        text        NOT NULL DEFAULT 'file' CHECK (kind = 'file'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_files_doc ON scm.purchase_return_files (purchase_return_id);
