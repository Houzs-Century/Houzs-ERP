-- 0215_autocount_do_mirror.sql — Houzs AutoCount Delivery Order header mirror.
--
-- The ASSR list's DO No column must come from AutoCount for Houzs cases
-- (Nico 2026-07-27); the SCM module's scm.delivery_orders only covers 2990.
-- The middleware exposes only /DeliveryOrder/getAll (~70 MB, ~11k docs; no
-- getSince yet) and the DO HEADER carries no FromDocNo — the SO linkage
-- exists per detail line only — so we mirror the handful of header fields
-- the list needs and match by the shared customer Ref (assr_cases.ref_no)
-- at query time. Refs arrive in mixed case ("znt4951" vs "ZNT6121"), hence
-- the LOWER() index. so_doc_nos stays NULL until a detail-enrichment pass
-- lands (future work).
CREATE TABLE IF NOT EXISTS autocount_delivery_orders (
  doc_no        text PRIMARY KEY,
  doc_date      text,
  ref           text,
  debtor_name   text,
  sales_agent   text,
  total         double precision,
  cancelled     integer NOT NULL DEFAULT 0,
  so_doc_nos    text,
  last_modified text,
  synced_at     text
);

CREATE INDEX IF NOT EXISTS idx_ac_do_ref
  ON autocount_delivery_orders (LOWER(ref));
