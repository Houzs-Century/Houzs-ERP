-- 20261007T1110_scm_stock_adjustments_backfill.sql
-- REVERSAL:
--   UPDATE scm.inventory_lot_consumptions c SET source_doc_id = NULL, source_doc_no = NULL
--     FROM scm.stock_adjustments h WHERE c.movement_id = h.id AND c.source_doc_id = h.id;
--   UPDATE scm.inventory_lots l SET source_doc_id = NULL, source_doc_no = NULL
--     FROM scm.stock_adjustments h WHERE l.movement_id = h.id AND l.source_doc_id = h.id;
--   UPDATE scm.inventory_movements m SET source_doc_id = NULL, source_doc_no = NULL
--     FROM scm.stock_adjustments h WHERE m.id = h.id AND m.source_doc_id = h.id;
--   DELETE FROM scm.stock_adjustments h WHERE EXISTS
--     (SELECT 1 FROM scm.inventory_movements m WHERE m.id = h.id);
--   The doc_number_counters rows for the SA series stay: a counter only moves up
--   and a gap is harmless (see 0316).
--
-- WHAT THIS CHANGES. Every manual stock adjustment written before BUG-66 gets a
-- document: ONE header + ONE line per old movement (owner choice 2026-10-07,
-- "one line, one document" — the old form posted each line on its own, so no
-- saved grouping exists to recover). The header id IS the movement id, which
-- keeps the old INVENTORY_ADJUSTMENT audit rows (keyed by movement id) on the
-- document they describe. The movement, the lot it opened and the consumptions
-- it took then carry source_doc_id / source_doc_no, the same link a new
-- adjustment gets. No qty, cost or balance changes.
--
-- WHICH ROWS. movement_type = 'ADJUSTMENT' AND source_doc_type = 'ADJUSTMENT'
-- AND source_doc_id IS NULL. DO-cancel and DR-resync rows also use
-- source_doc_type 'ADJUSTMENT' but always carry their DO / DR id, so they are
-- not touched. Stock-take corrections are source_doc_type 'STOCK_TAKE'.
--
-- NUMBERS. `<prefix>SA-<YYMM of created_at in Malaysia>-NNN`, numbered in
-- created_at order inside each series, prefix `HC-` for HOUZS and `<CODE>-` for
-- any other company (lib/companyScope.ts docPrefixForCode). The counter is then
-- raised past every number used, so the first live mint follows on.
--
-- RE-RUN: safe. A movement that already has a header (same id) is skipped, and a
-- linked movement no longer has source_doc_id NULL.

INSERT INTO scm.stock_adjustments
  (id, company_id, adjustment_no, warehouse_id, notes, created_by, created_at, updated_at)
SELECT n.id, n.company_id,
       n.series || '-' || lpad((n.base + n.rn)::text, 3, '0'),
       n.warehouse_id, NULL, n.performed_by, n.created_at, n.created_at
  FROM (
    SELECT s.*,
           row_number() OVER (PARTITION BY s.series ORDER BY s.created_at, s.id) AS rn,
           COALESCE((SELECT max((substring(h.adjustment_no from '-([0-9]+)$'))::int)
                       FROM scm.stock_adjustments h
                      WHERE h.adjustment_no LIKE s.series || '-%'), 0) AS base
      FROM (
        SELECT m.id, m.company_id, m.warehouse_id, m.performed_by, m.created_at,
               (CASE WHEN upper(co.code) = 'HOUZS' THEN 'HC-' ELSE upper(co.code) || '-' END)
                 || 'SA-' || to_char(m.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM') AS series
          FROM scm.inventory_movements m
          JOIN public.companies co ON co.id = m.company_id
         WHERE m.movement_type = 'ADJUSTMENT'
           AND m.source_doc_type = 'ADJUSTMENT'
           AND m.source_doc_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM scm.stock_adjustments x WHERE x.id = m.id)
      ) s
  ) n
ON CONFLICT (id) DO NOTHING;

INSERT INTO scm.stock_adjustment_lines
  (stock_adjustment_id, company_id, line_no, item_code, product_name, item_group,
   variants, description2, variant_key, batch_no, qty, unit_cost_sen, reason_code, notes, created_at)
SELECT h.id, h.company_id, 1, m.item_code, m.product_name, NULL,
       m.variants, m.description2, COALESCE(m.variant_key, ''), m.batch_no, m.qty,
       m.unit_cost_sen, m.reason_code, m.notes, m.created_at
  FROM scm.stock_adjustments h
  JOIN scm.inventory_movements m ON m.id = h.id
 WHERE m.qty <> 0
   AND NOT EXISTS (SELECT 1 FROM scm.stock_adjustment_lines l WHERE l.stock_adjustment_id = h.id);

UPDATE scm.inventory_movements m
   SET source_doc_id = h.id, source_doc_no = h.adjustment_no
  FROM scm.stock_adjustments h
 WHERE m.id = h.id
   AND m.source_doc_type = 'ADJUSTMENT'
   AND m.source_doc_id IS NULL;

UPDATE scm.inventory_lots l
   SET source_doc_id = h.id, source_doc_no = h.adjustment_no
  FROM scm.stock_adjustments h
 WHERE l.movement_id = h.id
   AND l.source_doc_type = 'ADJUSTMENT'
   AND l.source_doc_id IS NULL;

UPDATE scm.inventory_lot_consumptions c
   SET source_doc_id = h.id, source_doc_no = h.adjustment_no
  FROM scm.stock_adjustments h
 WHERE c.movement_id = h.id
   AND c.source_doc_type = 'ADJUSTMENT'
   AND c.source_doc_id IS NULL;

INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
SELECT head, mx + 1, '20261007T1110 backfill: max scm.stock_adjustments.adjustment_no (SA)'
  FROM (SELECT substring(adjustment_no from '^(.*)-[0-9]+$') AS head,
               max((substring(adjustment_no from '-([0-9]+)$'))::int) AS mx
          FROM scm.stock_adjustments
         GROUP BY 1) s
 WHERE head IS NOT NULL
ON CONFLICT (series) DO UPDATE
   SET next_n = GREATEST(c.next_n, EXCLUDED.next_n),
       updated_at = now();
