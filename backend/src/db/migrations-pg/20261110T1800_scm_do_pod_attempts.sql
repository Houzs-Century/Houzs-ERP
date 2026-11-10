-- Earlier delivery attempts of a Delivery Order (owner-approved 2026-11-10).
-- "Undo delivered" (delivery-order-revert.ts) takes a wrongly Delivered order
-- back to Loaded. Until now the POD photos, signature and GPS stayed on the
-- delivery_orders row and the driver's real POD later overwrote them, so the
-- first set of photos could no longer be opened from the order. The undo now
-- copies that POD set into one row here and clears it from the order; the R2
-- photo objects are never deleted, only referenced from this row instead.
--
-- One row per undo. attempt_no counts from 1 per delivery order.
-- pod_photo_keys is a JSON array of R2 keys in the shared houzs-erp bucket,
-- exactly as delivery_orders.pod_photo_keys holds them. undone_by is the
-- public.users id of whoever pressed Undo; undone_by_name is a snapshot so the
-- history reads the same after a rename.
--
-- One new empty table and its indexes; nothing existing is rewritten.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.delivery_order_pod_attempts;
--   Revert the code first (routes/delivery-order-revert.ts writes it,
--   routes/delivery-order-pod-attempts.ts reads it). Dropping it loses the
--   references to earlier-attempt photos (the R2 objects themselves remain).
--   GRANTS: none to re-apply; the table rides the scm schema's default
--   privileges (service_role), like scm.delivery_issues.

CREATE TABLE IF NOT EXISTS scm.delivery_order_pod_attempts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         BIGINT,
  delivery_order_id  UUID NOT NULL,
  attempt_no         INTEGER NOT NULL CHECK (attempt_no >= 1),
  undone_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_by          BIGINT,
  undone_by_name     TEXT,
  reason             TEXT NOT NULL,
  from_status        TEXT,
  departure_at       TIMESTAMPTZ,
  arrival_at         TIMESTAMPTZ,
  signed_at          TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  signature_data     TEXT,
  pod_r2_key         TEXT,
  pod_photo_keys     JSONB NOT NULL DEFAULT '[]'::jsonb,
  pod_lat            DOUBLE PRECISION,
  pod_lng            DOUBLE PRECISION,
  pod_accuracy_m     DOUBLE PRECISION,
  pod_located_at     TIMESTAMPTZ,
  CONSTRAINT delivery_order_pod_attempts_one_no UNIQUE (delivery_order_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS idx_do_pod_attempts_company ON scm.delivery_order_pod_attempts (company_id);
