-- 0251_scm_dp_orders_transfer_lorry_refs.sql
-- The source links a TRANSFER or LORRY_SERVICE DP order needs (job types added
-- in 0250).
--
-- WHY. scm.dp_orders (mig 0129) snapshots its party and keeps a soft link back
-- to whichever master filled it — so_doc_no / do_id / assr_case_id /
-- supplier_id / project_id. The two new job types have masters that are not in
-- that list, so today a transfer or a lorry-service job could be created but
-- not traced back to the document it came from.
--
--   stock_transfer_id  scm.stock_transfers — the transfer document being driven.
--                      NULL for an ad-hoc move with no document (the owner asked
--                      for both paths: pick a transfer, or type it in).
--   warehouse_id       scm.warehouses — the DESTINATION of the move, and the
--                      party the address snapshot came from. Kept even when
--                      stock_transfer_id is set: the transfer's to_warehouse can
--                      later be edited, and this records where the fleet was
--                      actually sent.
--   lorry_id           scm.lorries — the lorry being SERVICED. This is the
--                      job's subject, and is NOT the lorry that performs the
--                      job (that one is the trip's, via trip_id/trip_stop_id).
--   workshop_id        scm.workshops (mig 0241) — where the lorry is going, and
--                      the party master for LORRY_SERVICE.
--   work_order_id      scm.lorry_work_orders (mig 0204) — the repair record this
--                      trip serves, when there is one. Provenance only; a lorry
--                      can be sent to a workshop before a WO exists.
--
-- BARE COLUMNS, NO FK — the same soft-link decision 0129 made and documented for
-- so_doc_no / assr_case_id: these cross schemas and masters that may be deleted,
-- and a DP order must survive its source being tidied up. The board's DP union
-- suppression key (so_doc_no / assr_case_id / do_id all null) is deliberately
-- NOT extended to these: a transfer or lorry-service job has no native board row
-- to double-count against, so it must keep showing.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill (no existing
-- row can have had either job type — 0250 minted them). RE-CHECK THE NUMBER AT
-- MERGE — 0251 was next free above 0250.

ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS stock_transfer_id uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS warehouse_id      uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS lorry_id          uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS workshop_id       uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS work_order_id     uuid;

-- "Which DP jobs did we raise for this lorry / this transfer" — the two lookups
-- a maintenance or stock screen will ask. Partial so the index only carries the
-- rows that have the link at all.
CREATE INDEX IF NOT EXISTS idx_dp_orders_lorry
  ON scm.dp_orders (lorry_id) WHERE lorry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dp_orders_stock_transfer
  ON scm.dp_orders (stock_transfer_id) WHERE stock_transfer_id IS NOT NULL;
