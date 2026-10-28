-- ----------------------------------------------------------------------------
-- 0235 — Per-line SO allocations for consolidated Purchase Orders.
--
-- THE GAP (owner decision, 2026-08-01): one PO line can serve SEVERAL customers
-- plus stock at once — a consolidated purchase. Live example 2990-PO-2606-023:
-- ONE qty-5 MAKOTO line covering SO-036 x1 + SO-029 x1 + 3 for stock.
-- purchase_order_items.so_item_id is single-valued, so NO correct value exists
-- for such a line: any single link under-states the truth, and the 2026-08-01
-- backfill rightly refused to guess (BUG-HISTORY.md, "code two of the named
-- orders both still want"). The owner chose to build the missing structure
-- rather than weaken the rule: a sub-table of allocations, displayed as
-- sub-numbers per PO line (PO-2606-001-01, PO-2606-001-02, ...).
--
-- SEMANTICS.
--   * so_item_id NULL on an allocation = "for stock" (no customer).
--   * A line WITH allocations: the allocations are the AUTHORITATIVE
--     finer-grained answer and SUPERSEDE the line's own so_item_id wherever
--     both exist (po-so-coverage layer (b) reads them first — never both, so
--     never a double count).
--   * A line WITHOUT allocations: the single-valued so_item_id keeps working
--     exactly as before (the 1:1 fast path). Nothing existing changes shape.
--   * seq is 1-based and DENSE per line (the write path resequences on
--     delete); UNIQUE (purchase_order_item_id, seq) makes the sub-number
--     printable and stable.
--
-- WHAT THIS TABLE IS NOT. It is ATTRIBUTION metadata — which customer a
-- purchased unit was for. It moves no stock, no money, no quota:
-- recomputeSoPicked still counts ONLY purchase_order_items.so_item_id, MRP
-- layer (c) and the delivered layer (a) are untouched, and nothing reads this
-- table at costing time. That is also why allocation edits are deliberately
-- NOT blocked by the PO downstream lock: the 8 contended historical lines the
-- owner wants to allocate by hand are on RECEIVED POs.
--
-- WHY TRIGGERS AND NOT ONLY THE WRITE PATH. The invariant is
-- SUM(allocations.qty) <= line.qty, which spans rows, so no CHECK can hold it.
-- The route validates first (friendly 409s with numbers), but the app write is
-- check-then-insert over PostgREST with NO transaction around the pair — two
-- concurrent writers can both pass the check and land an over-allocation. The
-- repo standard for money-path invariants is a DB-side guard (0088/0155/0230);
-- an over-allocation here would silently mis-attribute customer goods, so the
-- same standard applies. The parent line is locked FOR UPDATE to serialise
-- concurrent allocation writers on one line.
--
-- The mirror guard: shrinking purchase_order_items.qty below the allocated sum
-- would break the same invariant from the other side. The line-PATCH route
-- pre-checks and 409s in plain language; this trigger is the backstop for
-- every other qty writer (amendments via reviseBoundPo included — a revision
-- that shrinks a split line below its allocations SHOULD fail loudly and name
-- the fix, not silently keep a wrong split).
--
-- ON DELETE behaviour, chosen to match the existing so_item_id conventions:
--   * purchase_order_item_id ON DELETE CASCADE — an allocation cannot outlive
--     its line (the line delete path already cascades items off a deleted PO).
--   * so_item_id ON DELETE SET NULL — the same rule the three existing
--     so_item_id FKs declare (2990s-full-schema.sql:1747 etc.): the row
--     survives, only the link goes; a customer allocation degrades to a stock
--     allocation rather than vanishing. NOTE the known consequence class
--     (BUG-HISTORY 2026-07-30, TBC swap): so-line-relink carries
--     purchase_order_items/delivery_order_items/sales_invoice_items across an
--     exchange but NOT this table — a TBC swap on an allocated line degrades
--     its allocations to stock. Accepted for now: the allocation UI shows the
--     degradation honestly, and widening so-line-relink is a follow-up the
--     module guide records.
--
-- NO backfill. The 8 contended lines stay unallocated for the OWNER to split
-- by hand in the new UI — that is the point of building it (the evidence the
-- backfill lacked exists only in his head). NO demo data (repo rule).
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned; no
-- inner BEGIN/COMMIT (pg-migrate owns the txn); IF NOT EXISTS / CREATE OR
-- REPLACE so the file is re-runnable; dollar-quoted bodies ($fn$) so
-- scripts/lib/split-sql.mjs keeps the PL/pgSQL intact. Exercised end-to-end
-- against a real postgres:16 in backend/tests-pg/poItemAllocations.pg.test.ts
-- (CI job backend-postgres -> npm run test:pg), which applies THIS file.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.purchase_order_item_allocations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              bigint NOT NULL REFERENCES public.companies(id),
  purchase_order_item_id  uuid   NOT NULL REFERENCES scm.purchase_order_items(id) ON DELETE CASCADE,
  -- 1-based, dense per line; the printable sub-number is po_number || '-' || lpad(seq).
  seq                     integer NOT NULL CHECK (seq >= 1),
  qty                     integer NOT NULL CHECK (qty > 0),
  -- NULL = this slice of the line is FOR STOCK (no customer).
  so_item_id              uuid REFERENCES scm.mfg_sales_order_items(id) ON DELETE SET NULL,
  -- scm.staff UUID (the /api/scm/* caller identity), same as the sibling tables.
  created_by              uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_item_alloc_seq_unique UNIQUE (purchase_order_item_id, seq)
);

COMMENT ON TABLE scm.purchase_order_item_allocations IS
  'Sub-line allocations of ONE purchase_order_items row across the customers (and stock) a consolidated purchase serves. so_item_id NULL = stock. When any allocations exist for a line they are the authoritative fine-grained answer and supersede the line''s single so_item_id in po-so-coverage layer (b); a line with none keeps the 1:1 so_item_id fast path. Attribution metadata only: moves no stock, no money, no po_qty_picked. Sum(qty) per line may never exceed the line qty (trg_po_item_alloc_guard / trg_po_item_qty_guard).';
COMMENT ON COLUMN scm.purchase_order_item_allocations.seq IS
  '1-based dense sequence per PO line; renders as the sub-number PO-xxxx-yy-0N. The write path resequences after a delete; UNIQUE (purchase_order_item_id, seq) keeps it printable.';
COMMENT ON COLUMN scm.purchase_order_item_allocations.so_item_id IS
  'The Sales Order line this slice serves; NULL = for stock. ON DELETE SET NULL matches the existing so_item_id FK convention (row survives, link degrades to stock).';

CREATE INDEX IF NOT EXISTS idx_po_item_alloc_item
  ON scm.purchase_order_item_allocations (purchase_order_item_id);
-- Reverse lookups (which PO lines serve this SO line) only ever start from a
-- real link, so the partial index skips the stock rows.
CREATE INDEX IF NOT EXISTS idx_po_item_alloc_so_item
  ON scm.purchase_order_item_allocations (so_item_id)
  WHERE so_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_po_item_alloc_company
  ON scm.purchase_order_item_allocations (company_id);

-- ── Guard 1: an allocation write may never push the line over its qty ────────
CREATE OR REPLACE FUNCTION scm.fn_po_item_alloc_guard()
RETURNS trigger
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_line_qty  integer;
  v_other_sum integer;
BEGIN
  -- Lock the parent line: serialises two concurrent allocation writers on the
  -- same line, so both cannot pass the sum check with the pre-image.
  SELECT qty INTO v_line_qty
    FROM scm.purchase_order_items
   WHERE id = NEW.purchase_order_item_id
   FOR UPDATE;
  IF v_line_qty IS NULL THEN
    RAISE EXCEPTION 'po_line_not_found: purchase_order_item % does not exist', NEW.purchase_order_item_id;
  END IF;

  SELECT COALESCE(SUM(qty), 0) INTO v_other_sum
    FROM scm.purchase_order_item_allocations
   WHERE purchase_order_item_id = NEW.purchase_order_item_id
     AND id <> NEW.id;

  IF v_other_sum + NEW.qty > v_line_qty THEN
    RAISE EXCEPTION 'allocation_exceeds_line_qty: allocations % + % exceed line qty %',
      v_other_sum, NEW.qty, v_line_qty;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_po_item_alloc_guard ON scm.purchase_order_item_allocations;
CREATE TRIGGER trg_po_item_alloc_guard
  BEFORE INSERT OR UPDATE OF qty, purchase_order_item_id
  ON scm.purchase_order_item_allocations
  FOR EACH ROW EXECUTE FUNCTION scm.fn_po_item_alloc_guard();

COMMENT ON FUNCTION scm.fn_po_item_alloc_guard() IS
  'Backstop for the route validation: SUM(allocations.qty) per PO line may never exceed the line qty. Locks the parent purchase_order_items row FOR UPDATE so concurrent allocation writers on one line serialise instead of both passing a stale sum. Raises allocation_exceeds_line_qty.';

-- ── Guard 2: a line-qty shrink may never undercut its allocations ────────────
CREATE OR REPLACE FUNCTION scm.fn_po_item_qty_guard()
RETURNS trigger
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_alloc_sum integer;
BEGIN
  -- Only a shrink can break the invariant; skip the common no-change/grow path.
  IF NEW.qty >= OLD.qty THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(qty), 0) INTO v_alloc_sum
    FROM scm.purchase_order_item_allocations
   WHERE purchase_order_item_id = NEW.id;
  IF v_alloc_sum > NEW.qty THEN
    RAISE EXCEPTION 'line_qty_below_allocated: line qty % is below the % already allocated - delete or shrink the line''s allocations first',
      NEW.qty, v_alloc_sum;
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_po_item_qty_guard ON scm.purchase_order_items;
CREATE TRIGGER trg_po_item_qty_guard
  BEFORE UPDATE OF qty
  ON scm.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_po_item_qty_guard();

COMMENT ON FUNCTION scm.fn_po_item_qty_guard() IS
  'The mirror of fn_po_item_alloc_guard: shrinking a PO line''s qty below its allocated sum breaks SUM(alloc) <= qty from the other side. The line-PATCH route pre-checks with a friendly 409; this catches every other qty writer (amendment revisions included) loudly, naming the fix. Raises line_qty_below_allocated.';
