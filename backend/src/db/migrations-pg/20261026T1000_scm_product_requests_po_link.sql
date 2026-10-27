-- 20261026T1000_scm_product_requests_po_link.sql
-- REVERSAL: UPDATE scm.product_requests SET status = 'APPROVED' WHERE status = 'PO_ISSUED';
--   ALTER TABLE scm.product_requests DROP CONSTRAINT IF EXISTS product_requests_status_check;
--   ALTER TABLE scm.product_requests ADD CONSTRAINT product_requests_status_check
--     CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PCO_ISSUED', 'CLOSED'));
--   DROP INDEX IF EXISTS scm.idx_product_requests_po;
--   ALTER TABLE scm.product_requests DROP COLUMN IF EXISTS po_id;
--   Revert the code first (shared/product-request.ts PO_ISSUED + issue_po,
--   routes/product-requests.ts POST /:id/link-po, the frontend Raise PO door).
--   The Purchase Orders raised from a request stay — only the request's link
--   to them goes, and those requests read APPROVED again.
--   GRANTS: none to re-apply — a column and a constraint ride the table's grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- NULLABLE column (every existing request reads NULL) with a partial index, and
-- the CHECK on scm.product_requests.status gains one allowed value. Every
-- existing row already satisfies the wider check; no row is written. The old
-- check was declared inline (20261006T0741), so Postgres named it; it is found
-- in the catalogue by what it checks and re-added under the explicit name (the
-- 20261007T0904 pattern). The DO block is ONE line because pg-migrate splits on
-- ";\n" and does not see $$.
--
-- WHY (2990-0015, Sim 2026-10-26): an approved product request only raised a
-- Purchase Consignment Order, but some requests are bought outright from the
-- supplier on a normal Purchase Order. The Purchaser now raises either; a PO
-- raised from a request is linked back (po_id) and the request reads
-- PO_ISSUED, the PO twin of PCO_ISSUED.

SET search_path = public, scm;

ALTER TABLE scm.product_requests
  ADD COLUMN IF NOT EXISTS po_id uuid NULL REFERENCES scm.purchase_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_product_requests_po ON scm.product_requests (po_id) WHERE po_id IS NOT NULL;

DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'scm.product_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%PCO_ISSUED%' LOOP EXECUTE format('ALTER TABLE scm.product_requests DROP CONSTRAINT %I', c.conname); END LOOP; END $$;
ALTER TABLE scm.product_requests ADD CONSTRAINT product_requests_status_check
  CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PCO_ISSUED', 'PO_ISSUED', 'CLOSED'));
