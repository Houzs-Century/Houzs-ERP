-- ----------------------------------------------------------------------------
-- 0277 — A RECEIPT CEILING that every writer obeys: a PO line may never be
--        received beyond what was ordered, unless a human explicitly grants
--        headroom and says why.
--
-- THE GAP. Production carries 65 purchase_order_items (of 864, 7.5%) whose
-- received_qty EXCEEDS qty — 73 excess units. The application was never the
-- hole: backend/src/scm/routes/grns.ts already 409s `qty_exceeds_remaining` at
-- nine sites behind verifyGrnOverReceipt(). Every one of the 65 was written by
-- a CUTOVER SCRIPT that opens its own postgres() connection and UPDATEs
-- purchase_order_items directly, so not one line of that route code ran.
--
--   backend/scripts/import-ac-so-linked-pos.mjs read AutoCount's GrQty as a
--   per-line receipt. It is a per-(DocNo, ItemCode) received ROLLUP, stamped
--   identically onto every detail line of the group — verified in the committed
--   snapshot: GrQty is identical across all 38 multi-line groups. So N lines of
--   one item each claimed the WHOLE group's receipt. PO-009018 is the shape:
--   two AutoCount lines, Qty 1 each, GrQty 2 each — ordered 2, received 2, but
--   every line claiming 2. create-migrated-documents.mjs then mirrored that
--   number into grn_items.qty_accepted, which is why ONE migrated GRN
--   (HC-GR-004913) shows the same 2 against four lines that each ordered 1.
--
-- WHY A TRIGGER AND NOT A CHECK. Two reasons, both decisive.
--   1. The child-side invariant — SUM(qty_accepted - returned_qty) over live
--      GRN lines <= the PO line's qty — spans ROWS. No CHECK can hold it.
--   2. Those 65 rows exist RIGHT NOW. A plain CHECK could not even be added
--      (and a NOT VALID one guards nothing until VALIDATEd, which cannot happen
--      until the repair runs). A trigger fires only on writes, so it closes the
--      hole the moment it deploys and leaves the historical repair independent
--      — the two land in either order without a deadlock between them.
--
-- The repo standard for a money/stock-path invariant is a DB-side guard
-- (0088 / 0155 / 0230 / 0235). This file follows 0235's shape exactly: a
-- child-side guard, a parent-side mirror, both locking the parent FOR UPDATE so
-- concurrent writers serialise instead of both passing a stale sum. The route's
-- check-then-write pair has NO transaction around it (it goes through
-- PostgREST), so two concurrent receipts can each pass the app check and still
-- land an over-receipt. Only the database can actually hold this line.
--
-- OVER-RECEIPT IS A REAL BUSINESS EVENT — SO IT IS ALLOWED, LOUDLY.
-- Suppliers do over-ship, and refusing the receipt outright would just push
-- staff into editing the PO to hide it. So the ceiling is qty +
-- over_receipt_allowed_qty, and the allowance is inert until a human sets it:
-- a CHECK makes an allowance IMPOSSIBLE to record without both a non-empty
-- reason and the staff id who granted it. There is no silent accept and no
-- global tolerance percentage — the decision is per line, attributable, and
-- readable on the document forever.
--
-- MIGRATED DOCUMENTS ARE NOT EXEMPT. scm.grns.migrated_no_stock (0276) means
-- "this document posts NO inventory movement", not "this document may exceed
-- the order". Nothing legitimate needs received > ordered, and the migrated
-- GRNs are precisely the population that broke. The app already treats
-- received_qty <= qty as an invariant elsewhere (po-revision.ts:21,141-146
-- refuses an amendment that would drop qty below received_qty).
--
-- BATCH RECEIVING IS UNTOUCHED. The cap is on the SUM across live GRN lines,
-- never on a single receipt, so 2 + 3 + 5 against a qty-10 line all pass and
-- the 11th unit is what fails. DRAFT and CANCELLED GRNs contribute nothing —
-- the same rule recomputePoReceived and verifyGrnOverReceipt already use — so
-- two drafts can coexist on a line and a draft never falsely blocks a real
-- receipt. Because a DRAFT's lines do not count, the DRAFT -> POSTED transition
-- is where a draft over-receipt would otherwise slip through; guard 3 closes
-- exactly that door.
--
-- HOUZS CONVENTIONS — schema-qualified + SET search_path pinned; no inner
-- BEGIN/COMMIT (pg-migrate owns the txn); IF NOT EXISTS / CREATE OR REPLACE so
-- the file is re-runnable; dollar-quoted bodies ($fn$) so
-- scripts/lib/split-sql.mjs keeps the PL/pgSQL intact. Exercised end-to-end
-- against a real postgres:16 in backend/tests-pg/receiptCeiling.pg.test.ts
-- (CI job backend-postgres -> npm run test:pg), which applies THIS file and
-- proves the over-receipt lands WITHOUT the triggers and is refused WITH them.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- ── The explicit, recorded over-receipt allowance ────────────────────────────
ALTER TABLE scm.purchase_order_items
  ADD COLUMN IF NOT EXISTS over_receipt_allowed_qty integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS over_receipt_reason      text,
  ADD COLUMN IF NOT EXISTS over_receipt_by          uuid,
  ADD COLUMN IF NOT EXISTS over_receipt_at          timestamptz;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'po_item_over_receipt_nonneg'
       AND conrelid = 'scm.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE scm.purchase_order_items
      ADD CONSTRAINT po_item_over_receipt_nonneg
      CHECK (over_receipt_allowed_qty >= 0);
  END IF;

  -- The teeth of "never a silent accept": headroom cannot exist without a
  -- reason and an author. Safe to add now — every existing row is 0/NULL,
  -- which satisfies it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'po_item_over_receipt_attributed'
       AND conrelid = 'scm.purchase_order_items'::regclass
  ) THEN
    ALTER TABLE scm.purchase_order_items
      ADD CONSTRAINT po_item_over_receipt_attributed
      CHECK (
        over_receipt_allowed_qty = 0
        OR (over_receipt_by IS NOT NULL
            AND over_receipt_reason IS NOT NULL
            AND btrim(over_receipt_reason) <> '')
      );
  END IF;
END
$do$;

COMMENT ON COLUMN scm.purchase_order_items.over_receipt_allowed_qty IS
  'Operator-granted headroom ABOVE qty for this line, for a real supplier over-shipment. 0 = the ordered qty is the hard ceiling. Cannot be raised without over_receipt_reason and over_receipt_by (CHECK po_item_over_receipt_attributed), so an over-receipt is always an explicit, attributable decision and never a silent accept.';
COMMENT ON COLUMN scm.purchase_order_items.over_receipt_reason IS
  'Why this line is permitted to receive beyond the ordered qty. Required whenever over_receipt_allowed_qty > 0.';
COMMENT ON COLUMN scm.purchase_order_items.over_receipt_by IS
  'scm.staff UUID of whoever granted the over-receipt headroom. Required whenever over_receipt_allowed_qty > 0.';
COMMENT ON COLUMN scm.purchase_order_items.over_receipt_at IS
  'When the over-receipt headroom was granted.';

-- Finding granted over-receipts is a predicate, not a scan.
CREATE INDEX IF NOT EXISTS po_items_over_receipt_idx
  ON scm.purchase_order_items (company_id)
  WHERE over_receipt_allowed_qty > 0;

-- ── Shared cap helper ────────────────────────────────────────────────────────
-- One definition of "live receipt", used by all three guards so they can never
-- drift apart. Mirrors recomputePoReceived (grns.ts:775) exactly: net of
-- returns, clamped at 0, DRAFT and CANCELLED excluded. p_exclude_grn lets a
-- caller leave out the GRN it is currently judging and add its own numbers.
CREATE OR REPLACE FUNCTION scm.fn_po_line_live_received(
  p_po_item_id uuid,
  p_exclude_grn uuid DEFAULT NULL
)
RETURNS integer
SET search_path = scm, pg_temp
AS $fn$
  SELECT COALESCE(SUM(GREATEST(0, gi.qty_accepted - COALESCE(gi.returned_qty, 0))), 0)::integer
    FROM scm.grn_items gi
    JOIN scm.grns g ON g.id = gi.grn_id
   WHERE gi.purchase_order_item_id = p_po_item_id
     AND (p_exclude_grn IS NULL OR gi.grn_id <> p_exclude_grn)
     AND g.status::text NOT IN ('DRAFT', 'CANCELLED');
$fn$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION scm.fn_po_line_live_received(uuid, uuid) IS
  'Units currently received against a PO line: SUM(GREATEST(0, qty_accepted - returned_qty)) over non-DRAFT, non-CANCELLED GRN lines. The single definition of "live receipt" shared by the three receipt-ceiling guards and identical to recomputePoReceived''s rule.';

-- ── Guard 1: a GRN line may never push its PO line past the ceiling ──────────
CREATE OR REPLACE FUNCTION scm.fn_grn_item_receipt_guard()
RETURNS trigger
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_qty       integer;
  v_allowed   integer;
  v_status    text;
  v_others    integer;
  v_mine      integer;
BEGIN
  -- A GRN line with no PO line behind it is a free-standing receipt; there is
  -- no ordered qty to cap it against.
  IF NEW.purchase_order_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Lock the parent line so two concurrent receipts on one line serialise
  -- rather than both passing the check against the same pre-image.
  SELECT qty, over_receipt_allowed_qty
    INTO v_qty, v_allowed
    FROM scm.purchase_order_items
   WHERE id = NEW.purchase_order_item_id
   FOR UPDATE;

  IF v_qty IS NULL THEN
    RAISE EXCEPTION 'po_line_not_found: purchase_order_item % does not exist', NEW.purchase_order_item_id;
  END IF;

  SELECT status::text INTO v_status FROM scm.grns WHERE id = NEW.grn_id;

  -- A DRAFT or CANCELLED GRN commits no receipt, so its own lines are not
  -- capped here; guard 3 re-checks the whole document when a draft is posted.
  IF v_status IS NULL OR v_status IN ('DRAFT', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  -- Every OTHER live GRN, plus this row's own contribution. Counting NEW
  -- explicitly (rather than re-reading the table) is what makes this correct
  -- on INSERT, where the row is not yet visible to the helper.
  v_others := scm.fn_po_line_live_received(NEW.purchase_order_item_id, NEW.grn_id);
  SELECT COALESCE(SUM(GREATEST(0, gi.qty_accepted - COALESCE(gi.returned_qty, 0))), 0)
    INTO v_mine
    FROM scm.grn_items gi
   WHERE gi.grn_id = NEW.grn_id
     AND gi.purchase_order_item_id = NEW.purchase_order_item_id
     AND gi.id <> NEW.id;
  v_mine := v_mine + GREATEST(0, NEW.qty_accepted - COALESCE(NEW.returned_qty, 0));

  IF v_others + v_mine > v_qty + v_allowed THEN
    RAISE EXCEPTION
      'receipt_exceeds_ordered_qty: PO line % would hold % received against an ordered qty of %%s - grant an explicit over-receipt allowance with a reason if the supplier genuinely over-shipped',
      NEW.purchase_order_item_id, v_others + v_mine, v_qty,
      CASE WHEN v_allowed > 0 THEN ' (+' || v_allowed || ' allowed)' ELSE '' END;
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_grn_item_receipt_guard ON scm.grn_items;
CREATE TRIGGER trg_grn_item_receipt_guard
  BEFORE INSERT OR UPDATE OF qty_accepted, returned_qty, purchase_order_item_id, grn_id
  ON scm.grn_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_grn_item_receipt_guard();

COMMENT ON FUNCTION scm.fn_grn_item_receipt_guard() IS
  'Backstop for the route''s nine qty_exceeds_remaining 409s: the SUM of live receipts against a PO line may never exceed qty + over_receipt_allowed_qty. Caps the TOTAL, never a single receipt, so batch receiving is unaffected. Locks the parent purchase_order_items row FOR UPDATE so concurrent receipts serialise. Raises receipt_exceeds_ordered_qty.';

-- ── Guard 2: the parent mirror — the one that closes the importer hole ───────
-- The cutover scripts never touched grn_items on the way in; they UPDATEd
-- purchase_order_items.received_qty directly. This trigger is the only thing
-- that would have stopped them, and it is what stops the next such script.
CREATE OR REPLACE FUNCTION scm.fn_po_item_received_guard()
RETURNS trigger
SET search_path = scm, pg_temp
AS $fn$
BEGIN
  IF COALESCE(NEW.received_qty, 0) > NEW.qty + COALESCE(NEW.over_receipt_allowed_qty, 0) THEN
    RAISE EXCEPTION
      'receipt_exceeds_ordered_qty: PO line % cannot record % received against an ordered qty of %%s - grant an explicit over-receipt allowance with a reason if the supplier genuinely over-shipped',
      NEW.id, NEW.received_qty, NEW.qty,
      CASE WHEN COALESCE(NEW.over_receipt_allowed_qty, 0) > 0
           THEN ' (+' || NEW.over_receipt_allowed_qty || ' allowed)' ELSE '' END;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- UPDATE OF names the three columns that can break the invariant, so the 65
-- historical rows are NOT disturbed by unrelated edits to other columns. A
-- repair that lowers received_qty passes; only a write that would create or
-- widen a violation raises.
DROP TRIGGER IF EXISTS trg_po_item_received_guard ON scm.purchase_order_items;
CREATE TRIGGER trg_po_item_received_guard
  BEFORE INSERT OR UPDATE OF received_qty, qty, over_receipt_allowed_qty
  ON scm.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_po_item_received_guard();

COMMENT ON FUNCTION scm.fn_po_item_received_guard() IS
  'The mirror of fn_grn_item_receipt_guard, and the guard that would have prevented the 2026-08 cutover over-receipts: received_qty may never exceed qty + over_receipt_allowed_qty, no matter which writer sets it. The cutover importers bypassed every application check by opening their own postgres() connection and writing this column directly; a DB trigger is the only guard such a writer cannot skip. Raises receipt_exceeds_ordered_qty.';

-- ── Guard 3: posting a DRAFT re-checks the whole document ────────────────────
-- A DRAFT's lines deliberately do not count toward the cap, so an over-receipt
-- can be STAGED in a draft. It must not survive the transition that makes it
-- real. This fires on the status change itself, which is the only moment those
-- lines start counting.
CREATE OR REPLACE FUNCTION scm.fn_grn_post_receipt_guard()
RETURNS trigger
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  r record;
BEGIN
  IF OLD.status::text NOT IN ('DRAFT', 'CANCELLED')
     OR NEW.status::text IN ('DRAFT', 'CANCELLED') THEN
    RETURN NEW;   -- not a transition into a counting status
  END IF;

  FOR r IN
    SELECT gi.purchase_order_item_id AS poi,
           SUM(GREATEST(0, gi.qty_accepted - COALESCE(gi.returned_qty, 0)))::integer AS mine,
           poi.qty AS ordered,
           poi.over_receipt_allowed_qty AS allowed
      FROM scm.grn_items gi
      JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
     WHERE gi.grn_id = NEW.id
       AND gi.purchase_order_item_id IS NOT NULL
     GROUP BY gi.purchase_order_item_id, poi.qty, poi.over_receipt_allowed_qty
  LOOP
    IF scm.fn_po_line_live_received(r.poi, NEW.id) + r.mine > r.ordered + COALESCE(r.allowed, 0) THEN
      RAISE EXCEPTION
        'receipt_exceeds_ordered_qty: posting this GRN would put PO line % at % received against an ordered qty of % - grant an explicit over-receipt allowance with a reason if the supplier genuinely over-shipped',
        r.poi, scm.fn_po_line_live_received(r.poi, NEW.id) + r.mine, r.ordered;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_grn_post_receipt_guard ON scm.grns;
CREATE TRIGGER trg_grn_post_receipt_guard
  BEFORE UPDATE OF status
  ON scm.grns
  FOR EACH ROW EXECUTE FUNCTION scm.fn_grn_post_receipt_guard();

COMMENT ON FUNCTION scm.fn_grn_post_receipt_guard() IS
  'Closes the draft door: a DRAFT GRN''s lines do not count toward a PO line''s received total, so an over-receipt can be staged in a draft and would otherwise become real on posting without any row-level write to grn_items. Re-checks every line of the document on the transition into a counting status. Raises receipt_exceeds_ordered_qty.';
