-- 20261006T0741_scm_product_requests.sql
-- REVERSAL: ALTER TABLE scm.purchase_consignment_orders DROP COLUMN IF EXISTS source_product_request_id;
--   DROP TABLE IF EXISTS scm.product_requests;
--   Revert the code first (routes/product-requests.ts, and the
--   productRequestId door in routes/purchase-consignment-orders.ts POST /).
--   The Models and SKUs a request created (product_models / mfg_products) and
--   the PC Orders raised from one stay — only the request trail and the link
--   column go.
--   GRANTS: none to re-apply — the table rides the scm schema's default
--   privileges (service_role), like scm.acc_payment_requests; this file grants
--   nothing, so the reverse re-grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table and its indexes, plus one nullable column on
-- scm.purchase_consignment_orders (every existing PC Order reads NULL). No
-- existing row is written or altered.
--
-- WHY (owner 2026-10-06: to request new product / repack product — Application,
-- Model, Compartment, Fabric, Sofa size, Leg size, Special remarks, Delivery
-- location, Expected delivery date; 要审批, Purchaser 批; Sales 都能提; 然后这个会连接
-- purchase consignment order). A PRODUCT REQUEST is the salesperson's half:
-- what they want made — an existing SKU (item_code) or a Model the catalogue
-- does not have yet (proposed_model_name) — in which fabric, seat size and leg
-- size, for what use (showroom / customer order / sample), delivered where and
-- by when. The Purchaser answers it: approves or rejects (decision_note says
-- why); for a new Model, builds the Model + SKU from the request
-- (item_code / model_id are then filled in); then raises the Purchase
-- Consignment Order from it (pco_id, and the order's source_product_request_id
-- point at each other). Stored status:
--   REQUESTED   waiting for the Purchaser
--   APPROVED    the Purchaser said yes — a Model/SKU and a PC Order may follow
--   REJECTED    the Purchaser sent it back — decision_note says why; the
--               requester may fix it and send it again
--   WITHDRAWN   the requester took it back
--   PCO_ISSUED  a Purchase Consignment Order was raised from it (pco_id)
--   CLOSED      the Purchaser closed it (goods in, or nothing more to do)
-- request_no is {co}PDR-YYMM-NNN (lib/doc-no.ts mintMonthlyDocNo).

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.product_requests (
  id                     uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             bigint      NOT NULL,
  request_no             text        NOT NULL,
  request_type           text        NOT NULL CHECK (request_type IN ('NEW_PRODUCT', 'REPACK')),
  application            text        NOT NULL CHECK (application IN ('SHOWROOM', 'CUSTOMER_ORDER', 'SAMPLE')),
  requested_by           bigint      NOT NULL,
  requested_by_name      text,
  -- The product asked for: an existing SKU by code, or a Model the catalogue
  -- does not have yet, by the name the requester gives it. One of the two.
  item_code              text,
  proposed_model_name    text,
  model_id               uuid        REFERENCES scm.product_models(id) ON DELETE SET NULL,
  category               text        NOT NULL DEFAULT 'SOFA',
  compartment            text,
  fabric_code            text,
  seat_size              text,
  leg_size               text,
  qty                    integer     NOT NULL DEFAULT 1 CHECK (qty > 0),
  special_remarks        text,
  delivery_location_id   uuid        REFERENCES scm.warehouses(id) ON DELETE SET NULL,
  expected_delivery_date date,
  status                 text        NOT NULL DEFAULT 'REQUESTED'
                                     CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'PCO_ISSUED', 'CLOSED')),
  decision_note          text,
  decided_by             text,
  decided_at             timestamptz,
  pco_id                 uuid        REFERENCES scm.purchase_consignment_orders(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_requests_names_product CHECK (item_code IS NOT NULL OR proposed_model_name IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_requests_company_no ON scm.product_requests (company_id, request_no);
CREATE INDEX IF NOT EXISTS idx_product_requests_requester ON scm.product_requests (company_id, requested_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_requests_status ON scm.product_requests (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_requests_pco ON scm.product_requests (pco_id) WHERE pco_id IS NOT NULL;

-- The PC Order points back at the request it was raised from.
ALTER TABLE scm.purchase_consignment_orders
  ADD COLUMN IF NOT EXISTS source_product_request_id uuid REFERENCES scm.product_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pco_source_product_request ON scm.purchase_consignment_orders (source_product_request_id) WHERE source_product_request_id IS NOT NULL;
