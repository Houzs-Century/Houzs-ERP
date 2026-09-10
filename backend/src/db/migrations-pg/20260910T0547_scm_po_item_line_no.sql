-- ----------------------------------------------------------------------------
-- 20260910T0547 — a purchase order line remembers WHERE ON THE ORDER it sits.
--
-- Owner 2026-09-10, on a purchase order that printed a three-piece sofa with
-- the armless module first: 「我们的 Sales Order 都是从 L 到 R（L 在第一，R 在最
-- 后）」 — the left-arm piece leads, the armless pieces sit in the middle, the
-- right-arm piece closes. And 「照片是根据 line item 的顺序来的」, so the same
-- scramble hits the ITEM PHOTOS block on the printed PO, not only the table.
--
-- THE CAUSE, MEASURED, NOT REASONED. `scm.mfg_sales_order_items` carries
-- `line_no`. `scm.purchase_order_items` carried NO line-order column at all —
-- `line_total_sen` and `line_suffix` are the only columns whose name starts
-- with "line", and neither is an order. Every line of a converted sofa is
-- written by ONE insert, so they share a created_at to the microsecond; read
-- off production 2026-09-10 for HC-PO-2609-053, all three rows sit at
-- 2026-09-10 02:53:25.121542+00. The detail read's `.order('created_at')` then
-- has nothing to break the tie with, so Postgres answers in physical order —
-- and an UPDATE moves a row's physical position, which is why the same
-- document can print two ways on two days. (Observed live during this work:
-- one line of HC-PO-2609-053 was edited between two reads twenty minutes
-- apart and its position moved.)
--
-- HOW BIG IT IS, on production 2026-09-10 (read-only `claude_ro`):
--   734 purchase orders, 1,690 lines, 580 of them sofa lines
--   214 purchase orders carry MORE THAN ONE sofa line
--    43 of those print an armless piece (1NA / 2NA / CNR) at an end of the
--       run — which no sofa can physically be
--
-- ── THE BACKFILL, AND WHAT IT DELIBERATELY DOES NOT DO ──────────────────────
--
-- A PO line already records the SO line it serves (`so_item_id`, mig 0098), so
-- for a PO whose EVERY line carries one, the source order is DERIVABLE — it is
-- read off `mfg_sales_order_items.line_no`, not invented. 661 of the 734
-- purchase orders are in that state.
--
-- The other 73 are LEFT NULL. Their lines are manual, or their source SO line
-- has been deleted, and there is no evidence anywhere of the order a person
-- intended. Numbering them from created_at would look like a recovered order
-- and be a coin toss, so they keep NULL and the read falls back to
-- `created_at, id` — what they show today, made deterministic by the id.
--
-- NULLS FIRST is what the read uses, and that choice is load-bearing: a line
-- appended tomorrow to one of those 73 takes line_no 1 (max(NULL)+1) and must
-- land AFTER the lines that predate the column, not in front of them.
--
-- ORDERING KEY: (source SO doc_no, source SO line_no, created_at, id). doc_no
-- first so a PO merged from several sales orders keeps each order's lines
-- together; id last so the key is TOTAL and a re-run cannot answer differently.
--
-- WHAT THIS CHANGES ON SCREEN, counted rather than hand-waved. Of the 214
-- purchase orders carrying more than one sofa line, **142 will display their
-- rows in a different order** afterwards — they are re-sequenced into their
-- sales order's order. 40 of the 43 impossible ones become correct; the other
-- 3 stay wrong because THEIR SALES ORDER is in that order (HC-SO-011965,
-- HC-SO-013258, HC-SO-2609-018 — read one at a time, not inferred), and this
-- copies the sales order rather than second-guessing it.
--
-- That 142 is the one thing here that is not behaviour-preserving, and it is a
-- decision, not an accident. Two things make it defensible: the current order
-- is not stable anyway (the read has nothing to break the created_at tie with,
-- so "what it shows today" is not a fixed quantity), and this COPIES an order
-- the source document already holds rather than deriving one. It is NOT the
-- sofa handedness rule applied retroactively — the owner bounded that one
-- 「只针对新的order生效 旧的就不理了」 and it stays bounded: nothing here reads a
-- module code.
--
-- IF THE OWNER WANTS HISTORY LEFT ALONE, the change is to delete the backfill
-- statement below and ship the column empty: every existing PO then keeps
-- line_no NULL and reads `created_at, id` — today's order, made deterministic —
-- while every PO raised from now on is correct. Nothing else in this migration
-- or in the code depends on the backfill having run.
--
-- REVERSAL: ALTER TABLE scm.purchase_order_items DROP COLUMN line_no;
-- Ship it as a NEW migration — this file is checksummed the moment it reaches
-- prod. Dropping the column loses the backfill and returns every read to the
-- created_at tie-break, i.e. exactly the defect above; nothing else depends on
-- it, so the drop is safe and complete.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- Nullable on purpose: NULL means "this line predates the column and its order
-- could not be derived", which the read treats as "keep it where it was".
ALTER TABLE scm.purchase_order_items
  ADD COLUMN IF NOT EXISTS line_no integer;

COMMENT ON COLUMN scm.purchase_order_items.line_no IS
  'The line''s position on this purchase order, 1-based and dense per PO. Written where lines are BORN (convert from SO, manual add, amendment) and never recomputed by a display path. Carried from the source SO line''s own line_no at convert. NULL = predates the column and no source order was derivable; reads order line_no NULLS FIRST, created_at, id. See docs/modules/purchase-order.md.';

-- ── Backfill: only POs where EVERY line resolves to an SO line with a line_no ─
WITH derivable AS (
  SELECT i.purchase_order_id
    FROM scm.purchase_order_items i
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
   GROUP BY i.purchase_order_id
  HAVING bool_and(i.so_item_id IS NOT NULL AND s.line_no IS NOT NULL)
), numbered AS (
  SELECT i.id,
         row_number() OVER (
           PARTITION BY i.purchase_order_id
           ORDER BY s.doc_no, s.line_no, i.created_at, i.id
         ) AS n
    FROM scm.purchase_order_items i
    JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
   WHERE i.purchase_order_id IN (SELECT purchase_order_id FROM derivable)
)
UPDATE scm.purchase_order_items t
   SET line_no = numbered.n
  FROM numbered
 WHERE t.id = numbered.id
   AND t.line_no IS NULL;

-- The read is `WHERE purchase_order_id = $1 ORDER BY line_no NULLS FIRST,
-- created_at, id`. The existing index on purchase_order_id already selects the
-- rows; a document has a handful of lines, so the sort is free and a second
-- index would cost more on every write than it saves on any read.
