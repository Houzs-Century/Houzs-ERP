#!/usr/bin/env node
/* diag-ready-audit-2026-10-16 — READ-ONLY census for the SO line READY audit
 * (Wei Siang, 2026-10-16). Counts the production cases behind the audit's
 * code findings:
 *   F4  hard-bound lines whose own PO receipt was already delivered, so the
 *       allocator's min(received, remaining) over-states what is in hand
 *   F5  hard-bound lines lit by a PO line of a different item code
 *   F6  AutoCount cutover PO lines whose stored received_qty exceeds their
 *       ERP GRNs (a live recount would rewrite them)
 *   OR  PO lines whose ERP GRNs received more than ordered
 *   SC  sofa clean-up script signatures (HC-0104 / HC-0108 / HC-0110 shapes)
 *
 * READ-ONLY: every statement is a SELECT inside a READ ONLY transaction, and
 * MODE is ignored. Each section runs on its own so
 * a failing query prints its error and the rest still report.
 *
 * RE-RUN: prints the database as it is now.
 *
 * Usage: node scripts/diag-ready-audit-2026-10-16.mjs   Env: DATABASE_URL
 */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const LIST_MAX = 60;
const show = (title, rows) => {
  console.log(`\n=== ${title}: ${rows.length} row(s)`);
  for (const r of rows.slice(0, LIST_MAX)) console.log('  ' + JSON.stringify(r));
  if (rows.length > LIST_MAX) console.log(`  ... ${rows.length - LIST_MAX} more`);
};
/* Every query runs inside its own READ ONLY transaction: the database refuses
   any write in it, and a transaction-level mode survives the connection pooler
   (a session-level SET would not). */
const section = async (title, query) => {
  try { show(title, await sql.begin('read only', (tx) => tx.unsafe(query))); }
  catch (e) { console.log(`\n=== ${title}: QUERY FAILED: ${e.message}`); }
};

/* Shared CTEs, mirroring so-stock-allocation.ts: live SO = not in
   SO_TERMINAL_STATES; a DO counts once it is past DRAFT and not CANCELLED;
   returns count unless their DR is CANCELLED; bound = isHardBoundLine. */
const BASE = `
  live_so AS (
    SELECT doc_no, company_id, processing_date, status::text AS so_status
    FROM scm.mfg_sales_orders
    WHERE status::text NOT IN ('CANCELLED','CLOSED','SHIPPED','DELIVERED','INVOICED','DRAFT')
  ),
  lines AS (
    SELECT l.id, l.doc_no, s.company_id, s.so_status, (s.processing_date IS NOT NULL) AS has_pdate,
           l.item_code, lower(coalesce(l.item_group,'')) AS grp, l.qty::numeric AS qty,
           l.stock_status::text AS stored, l.stock_qty_ready, l.allocated_batch_no, l.warehouse_id
    FROM scm.mfg_sales_order_items l JOIN live_so s ON s.doc_no = l.doc_no
    WHERE l.cancelled = false
  ),
  bound AS (
    SELECT * FROM lines
    WHERE grp IN ('bedframe','sofa','fabric_accessory')
       OR (grp = 'mattress' AND item_code ~* '\\(SP\\)\\s*$')
  ),
  dlv AS (
    SELECT di.so_item_id, SUM(di.qty)::numeric AS q
    FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
    WHERE upper(coalesce(d.status::text,'')) NOT IN ('DRAFT','CANCELLED') AND di.so_item_id IS NOT NULL
    GROUP BY di.so_item_id
  ),
  ret AS (
    SELECT di.so_item_id, SUM(ri.qty_returned)::numeric AS q
    FROM scm.delivery_return_items ri
    JOIN scm.delivery_returns r ON r.id = ri.delivery_return_id
    JOIN scm.delivery_order_items di ON di.id = ri.do_item_id
    JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
    WHERE upper(coalesce(r.status::text,'')) <> 'CANCELLED'
      AND upper(coalesce(d.status::text,'')) NOT IN ('DRAFT','CANCELLED')
    GROUP BY di.so_item_id
  ),
  rcv AS (
    SELECT so_item_id, SUM(received_qty)::numeric AS q
    FROM scm.purchase_order_items WHERE received_qty > 0 AND so_item_id IS NOT NULL
    GROUP BY so_item_id
  ),
  live_grn AS (
    SELECT gi.purchase_order_item_id AS poi_id,
           SUM(GREATEST(0, coalesce(gi.qty_accepted,0) - coalesce(gi.returned_qty,0)))::numeric AS q
    FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
    WHERE gi.purchase_order_item_id IS NOT NULL AND g.status::text NOT IN ('CANCELLED','DRAFT')
    GROUP BY gi.purchase_order_item_id
  )`;

try {
  const [{ transaction_read_only: ro }] = await sql.begin('read only', (tx) => tx.unsafe('SHOW transaction_read_only'));
  console.log(`transaction read-only: ${ro}`);
  if (ro !== 'on') { console.error('the read-only transaction did not take; stopping'); process.exit(2); }

  await section('OVERVIEW live SO lines by company / bound / stored status', `
    WITH ${BASE}
    SELECT company_id,
           (grp IN ('bedframe','sofa','fabric_accessory') OR (grp='mattress' AND item_code ~* '\\(SP\\)\\s*$')) AS bound,
           stored, count(*)::int AS n
    FROM lines GROUP BY 1,2,3 ORDER BY 1,2,3`);

  /* F4: engine fill = min(received, remaining); in hand from the line's own
     receipt = received - delivered + returned. A sofa line with a batch went
     through the dye-lot path instead, so it is reported but flagged. */
  await section('F4 bound lines where the allocator over-states the own-PO receipt', `
    WITH ${BASE},
    calc AS (
      SELECT b.*, coalesce(d.q,0) AS delivered, coalesce(r.q,0) AS returned, coalesce(v.q,0) AS received,
             b.qty - coalesce(d.q,0) + coalesce(r.q,0) AS remaining
      FROM bound b LEFT JOIN dlv d ON d.so_item_id = b.id
      LEFT JOIN ret r ON r.so_item_id = b.id LEFT JOIN rcv v ON v.so_item_id = b.id
    )
    SELECT company_id, doc_no, so_status, item_code, grp, qty, received, delivered, returned, remaining,
           LEAST(received, remaining) AS engine_fill,
           LEAST(GREATEST(received - delivered + returned, 0), remaining) AS true_fill,
           stored, stock_qty_ready, allocated_batch_no IS NOT NULL AS via_sofa_batch, has_pdate
    FROM calc
    WHERE delivered > 0 AND remaining > 0 AND received > 0
      AND LEAST(received, remaining) > LEAST(GREATEST(received - delivered + returned, 0), remaining)
    ORDER BY company_id, doc_no`);

  await section('F5 bound lines with remaining qty linked to a received PO line of a different item code', `
    WITH ${BASE}
    SELECT b.company_id, b.doc_no, b.so_status, b.item_code AS so_item, poi.item_code AS po_item,
           po.po_number, po.status::text AS po_status, poi.received_qty, b.qty, b.stored,
           (poi.warehouse_id IS DISTINCT FROM b.warehouse_id) AS warehouse_differs
    FROM bound b
    JOIN scm.purchase_order_items poi ON poi.so_item_id = b.id AND poi.received_qty > 0
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN dlv d ON d.so_item_id = b.id LEFT JOIN ret r ON r.so_item_id = b.id
    WHERE upper(trim(poi.item_code)) <> upper(trim(b.item_code))
      AND b.qty - coalesce(d.q,0) + coalesce(r.q,0) > 0
    ORDER BY b.company_id, b.doc_no`);

  await section('F5b same, but warehouse differs only (same item code)', `
    WITH ${BASE}
    SELECT b.company_id, b.doc_no, b.item_code, po.po_number, b.stored,
           b.warehouse_id AS so_wh, poi.warehouse_id AS po_wh
    FROM bound b
    JOIN scm.purchase_order_items poi ON poi.so_item_id = b.id AND poi.received_qty > 0
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN dlv d ON d.so_item_id = b.id LEFT JOIN ret r ON r.so_item_id = b.id
    WHERE upper(trim(poi.item_code)) = upper(trim(b.item_code))
      AND b.warehouse_id IS NOT NULL AND poi.warehouse_id IS NOT NULL AND b.warehouse_id <> poi.warehouse_id
      AND b.qty - coalesce(d.q,0) + coalesce(r.q,0) > 0
    ORDER BY b.company_id, b.doc_no`);

  /* Drift split: the daily probe's list, by cutover vs ERP-native PO. */
  await section('DRIFT POs whose stored received_qty differs from live GRNs, by kind', `
    WITH ${BASE}
    SELECT po.company_id, (po.linked_ac_docno IS NOT NULL) AS ac_cutover,
           CASE WHEN coalesce(poi.received_qty,0) > coalesce(l.q,0) THEN 'stored>grn' ELSE 'stored<grn' END AS direction,
           count(DISTINCT po.id)::int AS pos, count(*)::int AS lines
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN live_grn l ON l.poi_id = poi.id
    WHERE po.status::text <> 'CANCELLED' AND coalesce(poi.received_qty,0) <> coalesce(l.q,0)
    GROUP BY 1,2,3
    ORDER BY 1,2,3`);

  await section('DRIFT lines on ERP-native POs (not AutoCount cutover)', `
    WITH ${BASE}
    SELECT po.company_id, po.po_number, po.status::text AS po_status, poi.item_code, poi.qty,
           poi.received_qty AS stored, coalesce(l.q,0) AS grn, poi.so_item_id IS NOT NULL AS so_linked
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN live_grn l ON l.poi_id = poi.id
    WHERE po.status::text <> 'CANCELLED' AND po.linked_ac_docno IS NULL
      AND coalesce(poi.received_qty,0) <> coalesce(l.q,0)
    ORDER BY po.po_number`);

  /* F6 exposure: a recount of these lines would write `grn`, not `stored`. */
  await section('F6 AutoCount cutover PO lines a live recount would rewrite (stored > ERP GRNs)', `
    WITH ${BASE}
    SELECT po.company_id, po.po_number, po.status::text AS po_status, poi.item_code, poi.qty,
           poi.received_qty AS stored, coalesce(l.q,0) AS grn,
           so.doc_no AS so_doc, so.stored AS so_line_status,
           (so.grp IN ('bedframe','sofa','fabric_accessory') OR (so.grp='mattress' AND so.item_code ~* '\\(SP\\)\\s*$')) AS so_bound
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN live_grn l ON l.poi_id = poi.id
    LEFT JOIN lines so ON so.id = poi.so_item_id
    WHERE po.status::text <> 'CANCELLED' AND po.linked_ac_docno IS NOT NULL
      AND coalesce(poi.received_qty,0) > coalesce(l.q,0)
    ORDER BY po.po_number`);

  await section('F6b cutover PO lines with ANY ERP GRN line on them (where a recount can be triggered today)', `
    WITH ${BASE}
    SELECT po.company_id, count(DISTINCT poi.id)::int AS lines, count(DISTINCT po.id)::int AS pos,
           count(DISTINCT poi.id) FILTER (WHERE coalesce(poi.received_qty,0) <> coalesce(l.q,0))::int AS lines_drifted
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN live_grn l ON l.poi_id = poi.id
    WHERE po.linked_ac_docno IS NOT NULL AND po.status::text <> 'CANCELLED'
      AND EXISTS (SELECT 1 FROM scm.grn_items gi WHERE gi.purchase_order_item_id = poi.id)
    GROUP BY 1 ORDER BY 1`);

  /* Over-receipt: every GRN line behind a PO line whose live GRNs exceed qty. */
  await section('OR PO lines whose live GRNs received more than ordered, with each GRN line', `
    WITH ${BASE},
    over AS (
      SELECT poi.id, po.company_id, po.po_number, po.linked_ac_docno IS NOT NULL AS ac_cutover,
             poi.item_code, poi.qty, poi.received_qty, l.q AS grn_total, poi.so_item_id
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      JOIN live_grn l ON l.poi_id = poi.id
      WHERE po.status::text <> 'CANCELLED' AND l.q > poi.qty
    )
    SELECT o.company_id, o.po_number, o.ac_cutover, o.item_code, o.qty, o.received_qty AS stored, o.grn_total,
           g.grn_number, g.status::text AS grn_status, g.linked_ac_gr_docno, g.created_at::date AS grn_created,
           gi.qty_accepted, gi.returned_qty,
           (SELECT count(*)::int FROM scm.inventory_movements m
             WHERE m.source_doc_type = 'GRN' AND m.source_doc_id = g.id AND m.movement_type::text = 'IN'
               AND m.item_code = gi.item_code) AS in_moves,
           s.doc_no AS so_doc, s.stock_status::text AS so_line_status
    FROM over o
    JOIN scm.grn_items gi ON gi.purchase_order_item_id = o.id
    JOIN scm.grns g ON g.id = gi.grn_id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = o.so_item_id
    ORDER BY o.po_number, g.grn_number`);

  /* Sofa clean-up signatures. SC1 = HC-0110: two PO lines of one PO share an
     AutoCount line key, one received and one not. */
  await section('SC1 PO lines sharing an AutoCount line key where one received and another did not (HC-0110 shape)', `
    WITH k AS (
      SELECT poi.purchase_order_id, poi.linked_ac_dtlkey,
             count(*)::int AS n, bool_or(poi.received_qty >= poi.qty) AS any_full,
             bool_or(coalesce(poi.received_qty,0) < poi.qty) AS any_short
      FROM scm.purchase_order_items poi
      WHERE poi.linked_ac_dtlkey IS NOT NULL
      GROUP BY 1,2 HAVING count(*) > 1
    )
    SELECT po.company_id, po.po_number, po.status::text AS po_status, poi.item_code, poi.qty, poi.received_qty,
           poi.unit_price_sen, poi.created_at::date AS line_created, s.doc_no AS so_doc, s.stock_status::text AS so_line_status
    FROM k
    JOIN scm.purchase_order_items poi ON poi.purchase_order_id = k.purchase_order_id AND poi.linked_ac_dtlkey = k.linked_ac_dtlkey
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = poi.so_item_id
    WHERE k.any_full AND k.any_short AND po.status::text <> 'CANCELLED'
    ORDER BY po.po_number, poi.item_code`);

  /* SC2 = HC-0104 / HC-0110 header shape: PO says RECEIVED but a line is short. */
  await section('SC2 POs marked RECEIVED that still have a line received < qty', `
    SELECT po.company_id, po.po_number, po.linked_ac_docno IS NOT NULL AS ac_cutover,
           poi.item_code, poi.qty, poi.received_qty, poi.unit_price_sen, poi.created_at::date AS line_created,
           s.doc_no AS so_doc, s.stock_status::text AS so_line_status, s.cancelled AS so_line_cancelled
    FROM scm.purchase_orders po
    JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = poi.so_item_id
    WHERE po.status::text = 'RECEIVED' AND coalesce(poi.received_qty,0) < poi.qty
    ORDER BY po.po_number`);

  /* SC3: lines added to an AutoCount cutover PO well after it was created and
     still short — grouped by the day they were added, so script runs show up
     as spikes. Amendment ADDs land here too; the date clusters tell them apart. */
  await section('SC3 short lines added to cutover POs after creation, by day added', `
    SELECT po.company_id, poi.created_at::date AS added_on, count(*)::int AS lines,
           count(DISTINCT po.id)::int AS pos, count(*) FILTER (WHERE coalesce(poi.unit_price_sen,0) = 0)::int AS zero_priced,
           string_agg(DISTINCT po.po_number, ' ' ORDER BY po.po_number) AS po_numbers
    FROM scm.purchase_order_items poi
    JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
    WHERE po.linked_ac_docno IS NOT NULL AND po.status::text <> 'CANCELLED'
      AND poi.created_at > po.created_at + interval '2 days'
      AND coalesce(poi.received_qty,0) < poi.qty
    GROUP BY 1,2 ORDER BY 1,2`);

  /* SC4: the three POs named in HC-0108, which looks like the HC-0110 shape. */
  await section('SC4 HC-0108 POs as they stand now', `
    WITH ${BASE}
    SELECT po.po_number, po.status::text AS po_status, poi.item_code, poi.qty, poi.received_qty AS stored,
           coalesce(l.q,0) AS grn, poi.unit_price_sen, poi.created_at::date AS line_created,
           s.doc_no AS so_doc, s.stock_status::text AS so_line_status
    FROM scm.purchase_orders po
    JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
    LEFT JOIN live_grn l ON l.poi_id = poi.id
    LEFT JOIN scm.mfg_sales_order_items s ON s.id = poi.so_item_id
    WHERE po.po_number IN ('HC-PO-009630','HC-PO-009718','HC-PO-009940')
    ORDER BY po.po_number, poi.item_code`);
} finally {
  await sql.end();
}
