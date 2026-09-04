-- 20260904T0800_scm_do_line_integrity_lock.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two guard triggers on the delivery-order pair. Neither writes a row; each
--   only REFUSES a statement that would leave a shipped delivery order without
--   the line rows that say what shipped.
--
--   1. scm.delivery_orders  BEFORE DELETE
--      A header that has an inventory OUT movement cannot be deleted. Goods
--      left the building against that document number; the row is a fact and
--      the only legal way out is CANCELLED (which keeps the row). The two
--      application rollback paths (items-insert failure, race-conflict) delete
--      a header that has NOT deducted stock yet, so they are untouched.
--
--   2. scm.delivery_order_items  CONSTRAINT TRIGGER, AFTER DELETE OR UPDATE OF
--      delivery_order_id, DEFERRABLE INITIALLY DEFERRED
--      When the transaction commits, the delivery order a row LEFT (by delete
--      or by re-parenting) must still hold at least one line row, if that
--      delivery order still exists, is not DRAFT/CANCELLED, and has either
--      shipped past LOADED or has an OUT movement. Deferred, so an edit that
--      deletes-then-reinserts inside ONE transaction is still legal; a
--      statement that ends the transaction with the document empty is not.
--      A cascaded delete (header gone) finds no header and lets the row go —
--      trigger 1 has already ruled on the header.
--
-- WHY (2026-09-04, docs/bugs — "a delivery order with no line rows read as
-- not delivered"). Three 2990 delivery orders (2607-016/018/019) carried
-- line_count, money and OUT movements from 2026-07-23 but ZERO rows in
-- delivery_order_items: their 8 lines sat under three header ids that no
-- longer existed. On 2026-09-02 a QR-scan batch marked 24 deliveries
-- DELIVERED; syncSoDeliveredFromDo read the empty documents as "no longer
-- fully delivered", released three delivered orders back to READY_TO_SHIP,
-- and MRP planned to buy sofas that were already in the customers' homes —
-- one of them taking a real PO away from the order it was raised for. The
-- same shape had already been hand-repaired once on 2026-08-17 (DO-2607-017,
-- 6 rows rebuilt) and the third instance of this family was the owner's
-- 「这个问题修了很多次了」. The lines were re-parented by hand on 2026-09-04;
-- this migration makes the empty-shipped-document state unreachable through
-- SQL, whatever the writer.
--
-- The FK delivery_order_items.delivery_order_id -> delivery_orders(id) is
-- ON DELETE CASCADE and validated, so the orphans could only have been written
-- by a path that bypassed it (a header replaced under a new id with the rows
-- left behind). That path is not in this repository's source; this lock
-- catches the OUTCOME at the database, which is the one place every writer
-- shares.
--
-- REPAIRS. A deliberate repair that needs to empty or delete a shipped
-- document runs `SET session_replication_role = replica` for its transaction
-- (both triggers are ordinary, not ENABLE ALWAYS) and says so in its audit
-- row. Nothing in the application does that.
--
-- Reversal: DROP TRIGGER IF EXISTS trg_do_line_integrity_lock ON scm.delivery_order_items;
--           DROP TRIGGER IF EXISTS trg_do_header_delete_lock ON scm.delivery_orders;
--           DROP FUNCTION IF EXISTS scm.fn_do_line_integrity_lock();
--           DROP FUNCTION IF EXISTS scm.fn_do_header_delete_lock();
--           Purely a guard — dropping it changes no stored data.
-- Verified against: prod Supabase anogrigyjbduyzclzjgn on 2026-09-04, applied
--           inside a transaction that was ROLLED BACK: deleting the last line
--           of DELIVERED 2990-DO-2607-016 was refused (check_violation),
--           deleting its header was refused, and deleting a line of a DO that
--           still keeps another line went through. Production schema untouched.

SET search_path TO scm, public;

-- 1. A shipped header is a fact; cancel it, never delete it.
CREATE OR REPLACE FUNCTION scm.fn_do_header_delete_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scm.inventory_movements m
     WHERE m.source_doc_type::text = 'DO'
       AND (m.source_doc_no = OLD.do_number OR m.source_doc_id::text = OLD.id::text)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('do_header_integrity: %s has inventory movements and cannot be deleted', OLD.do_number),
      HINT = 'Goods moved against this delivery order. Set status = CANCELLED instead of deleting the row.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_header_delete_lock ON scm.delivery_orders;
CREATE TRIGGER trg_do_header_delete_lock
  BEFORE DELETE ON scm.delivery_orders
  FOR EACH ROW EXECUTE FUNCTION scm.fn_do_header_delete_lock();

-- 2. A shipped delivery order keeps at least one line row.
CREATE OR REPLACE FUNCTION scm.fn_do_line_integrity_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  hdr       record;
  remaining integer;
  moved     boolean;
BEGIN
  IF OLD.delivery_order_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.delivery_order_id IS NOT DISTINCT FROM OLD.delivery_order_id THEN
    RETURN NULL;
  END IF;

  SELECT d.id, d.do_number, upper(coalesce(d.status::text, '')) AS status
    INTO hdr
    FROM scm.delivery_orders d
   WHERE d.id = OLD.delivery_order_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF hdr.status IN ('DRAFT', 'CANCELLED') THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO remaining
    FROM scm.delivery_order_items i
   WHERE i.delivery_order_id = OLD.delivery_order_id;
  IF remaining > 0 THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM scm.inventory_movements m
     WHERE m.movement_type::text = 'OUT'
       AND m.source_doc_type::text = 'DO'
       AND (m.source_doc_no = hdr.do_number OR m.source_doc_id::text = hdr.id::text)
  ) INTO moved;

  IF moved OR hdr.status <> 'LOADED' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('do_line_integrity: %s (%s) would be left with no line rows', hdr.do_number, hdr.status),
      HINT = 'A shipped delivery order must keep the lines that say what shipped. Cancel the document, or reduce a line, instead of removing every row.';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_line_integrity_lock ON scm.delivery_order_items;
CREATE CONSTRAINT TRIGGER trg_do_line_integrity_lock
  AFTER DELETE OR UPDATE OF delivery_order_id ON scm.delivery_order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION scm.fn_do_line_integrity_lock();
