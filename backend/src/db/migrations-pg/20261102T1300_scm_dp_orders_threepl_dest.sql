-- 20261102T1300_scm_dp_orders_threepl_dest.sql
-- A TRANSFER DP order can go to an OUTSOURCED warehouse, not only one we own
-- (owner 2026-11-02): the destination may be a 3PL company's warehouse.
--
-- WHY. dp-party.ts maps a TRANSFER's destination from scm.warehouses — OUR own
-- warehouse master. Goods are sometimes moved to a 3PL's warehouse, which is not
-- in that master, so it could not be picked and auto-filled. The operator now
-- picks it from scm.threepl_companies (mig 0210) instead; that master's single
-- free-text address fills the snapshot. This column records WHICH carrier — the
-- same soft provenance link warehouse_id / stock_transfer_id keep (mig 0251),
-- "where the fleet was actually sent" when the destination is outsourced.
--
-- BARE COLUMN, NO FK — the same soft-link decision 0129 / 0251 made for the other
-- source refs: it crosses to a master that may be tidied up, and a DP order must
-- survive that. party_type stays WAREHOUSE (an outsourced warehouse is still a
-- warehouse destination), so nothing that groups by party changes.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill — every
-- existing TRANSFER was to an owned warehouse. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_dp_orders_threepl_company;
--           ALTER TABLE scm.dp_orders DROP COLUMN IF EXISTS threepl_company_id;

ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS threepl_company_id uuid;

-- "Which DP jobs did we raise for this carrier" — partial, like idx_dp_orders_lorry.
CREATE INDEX IF NOT EXISTS idx_dp_orders_threepl_company
  ON scm.dp_orders (threepl_company_id) WHERE threepl_company_id IS NOT NULL;
