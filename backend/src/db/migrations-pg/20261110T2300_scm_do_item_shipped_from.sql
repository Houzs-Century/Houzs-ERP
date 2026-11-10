-- Lock, per delivery-order line, the PO(s) its goods came from and the rack(s)
-- they left, at the moment the order ships (owner rule 2026-11-10: "要确保知道拿
-- 的是什么PO，不会之后又乱乱给了，lock了之后 rack number 也是").
--
-- Until now the DO detail, the printed DO and the phone re-derived Source PO and
-- Rack on every read from the ledger (lot consumptions, batched OUT movements,
-- rack STOCK_OUT rows, with a bound-PO fallback), so a later FIFO repair, lot
-- relabel or re-cost could change what an already-confirmed DO named.
-- committed_po_batch_no (mig 0230) holds one PO decided BEFORE the ship for a
-- short line; it cannot say "3 from PO A, 2 from PO B, off racks L8.2 and L9.1".
--
-- shipped_from, a json object, written once by the ship chokepoint
-- (backend/src/scm/lib/do-shipped-from-stamp.ts; rule in
-- backend/scripts/lib/do-shipped-from.mjs):
--   { v: 1, at, src: 'ship' | 'backfill', item_code, qty,
--     pos: [{ po, qty }], adj_qty, racks: [{ rack_id, label, qty }],
--     returns: [{ at, why, reshipped_at }] }      (returns: revert / cancel notes)
-- NULL = not stamped (a draft, a service line, or a DO confirmed before this
-- migration until backend/scripts/stamp-do-shipped-from.mjs runs).
--
-- Write-once is enforced here as well as in the code: once set, everything but
-- the `returns` list is frozen, and the column can never be set back to NULL.
--
-- Additive: one nullable column (no rewrite), a NOT VALID check (no scan) and a
-- row trigger. The ALTERs bound their lock wait (docs/modules/delivery-order.md):
-- a busy table makes this fail fast and the deploy's migration step retries.
--
-- REVERSAL:
--   DROP TRIGGER IF EXISTS trg_do_item_shipped_from_write_once ON scm.delivery_order_items;
--   DROP FUNCTION IF EXISTS scm.fn_do_item_shipped_from_write_once();
--   ALTER TABLE scm.delivery_order_items DROP CONSTRAINT IF EXISTS delivery_order_items_shipped_from_object;
--   ALTER TABLE scm.delivery_order_items DROP COLUMN IF EXISTS shipped_from;
--   Revert the code first (the DO detail selects the column). Dropping it loses
--   the locked PO / rack per line; readers fall back to the worked-out answer.
--   GRANTS: none to restore; the column rides the table's existing grants.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE scm.delivery_order_items
  ADD COLUMN IF NOT EXISTS shipped_from jsonb;

ALTER TABLE scm.delivery_order_items
  DROP CONSTRAINT IF EXISTS delivery_order_items_shipped_from_object;
ALTER TABLE scm.delivery_order_items
  ADD CONSTRAINT delivery_order_items_shipped_from_object
  CHECK (shipped_from IS NULL OR jsonb_typeof(shipped_from) = 'object') NOT VALID;

COMMENT ON COLUMN scm.delivery_order_items.shipped_from IS
  'Locked at the first ship: the PO(s) of the lots this line consumed and the rack(s) it left, with qty. Write-once except the appended returns list (trigger). NULL = not stamped; readers then work it out and say so.';

CREATE OR REPLACE FUNCTION scm.fn_do_item_shipped_from_write_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.shipped_from IS NOT NULL
     AND (NEW.shipped_from IS NULL
          OR (NEW.shipped_from - 'returns') IS DISTINCT FROM (OLD.shipped_from - 'returns')) THEN
    RAISE EXCEPTION 'delivery_order_items.shipped_from is locked once set (line %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_item_shipped_from_write_once ON scm.delivery_order_items;
CREATE TRIGGER trg_do_item_shipped_from_write_once
  BEFORE UPDATE OF shipped_from ON scm.delivery_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_do_item_shipped_from_write_once();

COMMIT;
