-- 20260907T2340 — mark a delivery line whose item code the sales order does not
-- carry (ADDITIVE, one boolean, no backfill).
--
-- WHAT. `scm.delivery_order_items.ac_substituted` — true when the AutoCount
-- delivery line this row mirrors ships an item code that is NOT on the sales
-- order the delivery names, because the warehouse substituted the product at
-- dispatch.
--
-- WHY A COLUMN AND NOT A NOTE. The migrated DO importer used to DROP such a row,
-- and when it was a note's only row the whole document silently ceased to exist:
-- DO-001800 and DO-005583 were never created in the ERP, were not refused, were
-- not counted, and the AutoCount reconcile then printed them as
-- "(owner-declined)" — a gap reported as a decision. The owner's ruling
-- (2026-09-07, "改我们的程式，允许换型号") is that the document must come in.
--
-- Carrying it needs somewhere to say the codes DIFFER, or the system quietly
-- asserts a match it does not have. The row's `so_item_id` stays NULL — which
-- ordered line a substitution replaces is a human judgement and inventing it is
-- computing, not copying — so this flag is the only durable record that the row
-- is a substitution rather than an ordinary ad-hoc line. It is queryable, which
-- a sentence inside `description` is not.
--
-- DEFAULT false, so every existing row keeps its current meaning and no reader
-- changes behaviour until something sets it. Writers:
-- backend/scripts/lib/migrated-do-writer.mjs only.
--
-- REVERSAL: ALTER TABLE scm.delivery_order_items DROP COLUMN ac_substituted;
--   Reversible in full. Nothing is derived from it and no other column is
--   written differently because of it; the flag is a statement ABOUT rows that
--   are already correct on their own terms, so dropping it loses the marker and
--   nothing else. The same rows remain identifiable by
--   (so_item_id IS NULL AND delivery_orders.migrated_no_stock).

BEGIN;

ALTER TABLE scm.delivery_order_items
  ADD COLUMN IF NOT EXISTS ac_substituted boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm.delivery_order_items.ac_substituted IS
  'AutoCount delivered an item code the named sales order does not carry (substituted at dispatch). so_item_id is deliberately NULL: which ordered line it replaces is a human decision, so the order''s outstanding quantity is unchanged.';

COMMIT;
