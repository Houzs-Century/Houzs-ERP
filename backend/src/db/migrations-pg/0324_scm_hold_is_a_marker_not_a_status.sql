-- ----------------------------------------------------------------------------
-- RE-CHECK NUMBER AT MERGE — parallel PRs; last on main was 0323 when written.
--
-- 0324 — a HOLD becomes a MARKER on the document, beside the status, instead of
-- being written INTO the status.
--
-- THE OWNER, 2026-08-22: 「我们的hold是给我们知道一个 order hold这的」 — a hold is
-- there so people KNOW an order is paused. It is not a step in the document's
-- life. He also asked that releasing be looked at: 「take off hold也要看」.
--
-- THE DEFECT THIS CLOSES. Today `Put On Hold` writes status = 'ON_HOLD'
-- (frontend/src/pages/scm-v2/row-menus.ts). Holding an IN_PRODUCTION sales order
-- therefore DESTROYS the only record that it was in production — the status
-- column is the only place that fact lived. `Take Off Hold` then writes
-- 'CONFIRMED' unconditionally, so every released order lands on Confirmed no
-- matter where it actually was. Nothing anywhere stores the pre-hold status:
--   grep -rn "previous_status\|status_before\|held_from" backend/src/scm/
-- returns nothing. A hold is currently a one-way lossy operation.
--
-- SHAPE. Four columns per document table:
--   on_hold      boolean NOT NULL DEFAULT false   the marker itself
--   hold_reason  text                             why, in the operator's words
--   held_at      timestamptz                      when the marker went on
--   held_by      uuid                             who put it on
-- Take Off Hold clears the marker. The status column is never touched by either
-- direction, so a released document comes back exactly where it was. That is the
-- whole point of the change.
--
-- held_by IS uuid AND CARRIES NO FK, matching created_by on all five of these
-- tables — verified by reading the DDL rather than assuming it:
--   grep -n '"created_by"' backend/scripts/scm-schema/2990s-full-schema.sql
-- gives `"created_by" uuid` on mfg_sales_orders, purchase_orders, grns,
-- purchase_invoices and delivery_orders alike. No FK to scm.staff, for 0081's
-- reason repeated by 0278: the SCM auth bridge can pin a caller to the seeded
-- system-staff uuid and an FK would refuse legitimate writes.
--
-- THE DELIVERY ORDER GETS ITS FIRST HOLD EVER. Owner, 2026-08-21: 「再加到一个
-- Hold」. It was missed when the PO, the GRN and the PI got theirs on that day
-- (migs 0318/0319/0320). It needs NO enum change to get one now, which is the
-- clearest illustration of why a marker beats a status: scm.do_status is
-- untouched and the DO simply gains the same four columns as its four siblings.
--
-- THE `ON_HOLD` ENUM LABEL STAYS, FOR EVER, IN ALL FOUR TYPES THAT HAVE IT.
-- Postgres has no DROP VALUE. This migration does not remove it and could not.
-- The app stops WRITING it; every reader keeps rendering it, and the status
-- buckets keep a home for it, so a row that arrives carrying the label is still
-- reachable from a tab — the 37-invisible-delivery-orders fault that
-- statusBucketsEnumMembership.test.mjs exists to prevent.
--
-- NO BACKFILL IS NEEDED, and that is MEASURED, not assumed. The read-only
-- production probe `check-hold-and-shipped-rows.mjs` was dispatched at prod on
-- 2026-08-22, run 32573160010, and reported ZERO rows on ON_HOLD across all five
-- tables: Sales Order 108 rows / 0 held, Purchase Order 69 / 0, Goods Received
-- 51 / 0, Purchase Invoice 46 / 0, Delivery Order 44 / 0. So no status has to be
-- rewritten and no pre-hold status has to be recovered from
-- scm.entity_audit_log. Every new column starts at its default and no existing
-- row changes meaning. Had the count been non-zero, the pre-hold status could
-- only have come from that audit log, and rows without one would have needed a
-- decision rather than a guess.
--
-- Houzs SCM port conventions (mirrors 0317 / 0281): schema-qualified to scm.*,
-- plain ADD COLUMN IF NOT EXISTS — NOT a DO block, because pg-migrate splits
-- each file on ";\n" and would fragment a dollar-quoted one — additive,
-- re-run safe, so the auto-apply on every deploy is a no-op after the first.
--
-- VIEW-TRAP NOTE: every view over these five tables enumerates its columns
-- explicitly (0189, 0305, 0306, 0312 all list `so.created_by, so.priority_set_by,
-- ...`); none does SELECT *. ADD COLUMN cannot break a column-enumerated view,
-- which is the direction 0189 was destroyed from — that one DROPped and
-- recreated a view and lost its GRANTs. Nothing here drops or recreates
-- anything, so no GRANT is at risk.
--
-- THE INDEXES ARE PARTIAL AND THAT IS THE POINT. Each list's "On Hold" tab asks
-- for the held rows only, and held rows are the rare ones — a partial index on
-- `WHERE on_hold` stays a handful of pages instead of one entry per document.
--
-- REVERSAL:
--   ALTER TABLE scm.mfg_sales_orders  DROP COLUMN on_hold, DROP COLUMN hold_reason, DROP COLUMN held_at, DROP COLUMN held_by;
--   ALTER TABLE scm.purchase_orders   DROP COLUMN on_hold, DROP COLUMN hold_reason, DROP COLUMN held_at, DROP COLUMN held_by;
--   ALTER TABLE scm.grns              DROP COLUMN on_hold, DROP COLUMN hold_reason, DROP COLUMN held_at, DROP COLUMN held_by;
--   ALTER TABLE scm.purchase_invoices DROP COLUMN on_hold, DROP COLUMN hold_reason, DROP COLUMN held_at, DROP COLUMN held_by;
--   ALTER TABLE scm.delivery_orders   DROP COLUMN on_hold, DROP COLUMN hold_reason, DROP COLUMN held_at, DROP COLUMN held_by;
--   (the partial indexes go with their columns). Safe while no row is held —
--   which the probe above proves is true today; after this ships, dropping the
--   columns DISCARDS whatever holds staff have put on since, so re-read the
--   probe before reversing. Ship the reversal as a NEW migration: this file is
--   checksummed the moment it reaches prod and its body may never be edited.
-- Verified against: production schema + row read of all five tables via
-- workflow run 32573160010 (2026-08-22), and the vendored DDL in
-- backend/scripts/scm-schema/2990s-full-schema.sql for the column conventions.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE scm.purchase_orders ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS held_by uuid;

ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS on_hold boolean NOT NULL DEFAULT false;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE scm.delivery_orders ADD COLUMN IF NOT EXISTS held_by uuid;

CREATE INDEX IF NOT EXISTS idx_mfg_sales_orders_on_hold  ON scm.mfg_sales_orders  (company_id) WHERE on_hold;
CREATE INDEX IF NOT EXISTS idx_purchase_orders_on_hold   ON scm.purchase_orders   (company_id) WHERE on_hold;
CREATE INDEX IF NOT EXISTS idx_grns_on_hold              ON scm.grns              (company_id) WHERE on_hold;
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_on_hold ON scm.purchase_invoices (company_id) WHERE on_hold;
CREATE INDEX IF NOT EXISTS idx_delivery_orders_on_hold   ON scm.delivery_orders   (company_id) WHERE on_hold;
