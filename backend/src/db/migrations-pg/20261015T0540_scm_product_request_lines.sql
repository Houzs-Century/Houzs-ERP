-- 20261015T0540_scm_product_request_lines.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.product_request_lines;
--   ALTER TABLE scm.product_requests
--     ADD COLUMN IF NOT EXISTS item_code text,
--     ADD COLUMN IF NOT EXISTS proposed_model_name text,
--     ADD COLUMN IF NOT EXISTS model_id uuid REFERENCES scm.product_models(id) ON DELETE SET NULL,
--     ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'SOFA',
--     ADD COLUMN IF NOT EXISTS compartment text,
--     ADD COLUMN IF NOT EXISTS fabric_code text,
--     ADD COLUMN IF NOT EXISTS seat_size text,
--     ADD COLUMN IF NOT EXISTS leg_size text,
--     ADD COLUMN IF NOT EXISTS qty integer NOT NULL DEFAULT 1 CHECK (qty > 0),
--     ADD COLUMN IF NOT EXISTS unit_price_sen bigint CHECK (unit_price_sen IS NULL OR unit_price_sen >= 0);
--   Revert the code first (routes/product-requests.ts, lib/product-request-link.ts,
--   the frontend form + PC Order New seed). The reverse re-adds the one-product
--   columns EMPTY: a multi-line request raised in between loses its lines, so
--   copy line 1 of each open request back by hand before dropping the table.
--   GRANTS: none to re-apply — both tables ride the scm schema's default
--   privileges (service_role); this file grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table, and ten columns dropped from scm.product_requests. The table
-- holds 0 rows on production at the time of writing (checked 2026-10-15), so
-- no data is lost; the drop is listed above as reversible for the schema.
-- The old inline CHECK (product_requests_names_product) goes with its columns.
-- scm.purchase_consignment_orders is not touched.
--
-- WHY (owner 2026-10-15: 目前有问题，会批量填入 / 做成和 purchase consignment 细节 —
-- 方案 A): one request was one product, and the Sales Director has dozens of
-- showroom display pieces to ask for at once. A request is now a HEADER (type,
-- use, supplier, delivery location, expected date, remarks to the Purchaser)
-- plus LINES, the shape a Purchase Consignment Order has — each line a product:
-- an existing SKU (item_code) or a Model the catalogue does not have yet
-- (proposed_model_name), its category / compartment / fabric / seat / leg, a
-- qty, the agreed unit price and a line remark. The Purchaser approves the
-- whole request, builds the Model + SKU per new-Model line, and raises ONE
-- PC Order carrying every line.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.product_request_lines (
  id                  uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          bigint      NOT NULL,
  request_id          uuid        NOT NULL REFERENCES scm.product_requests(id) ON DELETE CASCADE,
  line_no             integer     NOT NULL CHECK (line_no > 0),
  -- The product asked for: an existing SKU by code, or a Model the catalogue
  -- does not have yet, by the name the requester gives it. One of the two.
  item_code           text,
  proposed_model_name text,
  model_id            uuid        REFERENCES scm.product_models(id) ON DELETE SET NULL,
  category            text        NOT NULL DEFAULT 'SOFA',
  compartment         text,
  fabric_code         text,
  seat_size           text,
  leg_size            text,
  qty                 integer     NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_sen      bigint      CHECK (unit_price_sen IS NULL OR unit_price_sen >= 0),
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_request_lines_names_product CHECK (item_code IS NOT NULL OR proposed_model_name IS NOT NULL),
  CONSTRAINT product_request_lines_request_line UNIQUE (request_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_product_request_lines_request ON scm.product_request_lines (company_id, request_id, line_no);
CREATE INDEX IF NOT EXISTS idx_product_request_lines_item ON scm.product_request_lines (company_id, item_code) WHERE item_code IS NOT NULL;

ALTER TABLE scm.product_requests DROP CONSTRAINT IF EXISTS product_requests_names_product;
ALTER TABLE scm.product_requests
  DROP COLUMN IF EXISTS item_code,
  DROP COLUMN IF EXISTS proposed_model_name,
  DROP COLUMN IF EXISTS model_id,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS compartment,
  DROP COLUMN IF EXISTS fabric_code,
  DROP COLUMN IF EXISTS seat_size,
  DROP COLUMN IF EXISTS leg_size,
  DROP COLUMN IF EXISTS qty,
  DROP COLUMN IF EXISTS unit_price_sen;
