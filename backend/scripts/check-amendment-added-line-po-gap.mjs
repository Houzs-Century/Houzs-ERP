// Read-only: HOW MANY sales orders right now carry an amendment-ADDED line that
// reached no purchase order, in the population where the buyer was told nothing?
//
// The bug (owner 2026-09-10, 「要,查到底并修掉」): reviseBoundPo raises two warnings
// when an amendment-added line reaches no purchase order — "no supplier set" and
// "supplier has no open PO on this sales order". Both were gated on scopeCoversAll,
// which is FALSE on any confirm scoped to one PO of a sales order that has 2+ live
// bound POs (the PO-Amendments confirm is always scoped to one). So on a 2+-PO SO
// the warning was structurally suppressed and the missing order surfaced only on
// delivery day. This script sizes that exposure against production, read-only.
//
// It asks, for company COMPANY_ID:
//   P        = sales orders with 2+ LIVE (non-cancelled) bound purchase orders —
//              the population where the warning could not fire.
//   E_upper  = of those, sales orders carrying a current, NON-service SO line that
//              (a) has no live covering PO line and (b) was ADDED by an amendment
//              (a so_amendment_lines change_type='ADD' whose new_item_code matches
//              the line's item_code). An upper bound: a line still awaiting a
//              sibling PO's follow-up confirm looks the same in a snapshot.
//   E_gap    = the subset of E_upper the WARNING itself would fire on — the line
//              has no main-supplier binding at all, OR its main supplier owns none
//              of the SO's live bound POs. This mirrors so-revision.ts lines ~1310
//              and ~1319 exactly, so it is the count the fix turns from silent
//              into surfaced.
//
// Bound = a live PO carrying a line whose so_item_id is a CURRENT SO line, which is
// how reviseBoundPo derives its bound set (an orphan-only PO — every bound line
// removed — is transient and not counted; the difference is immaterial to sizing).
//
// The 0-PO and 1-PO buckets are printed beside the 2+-PO one so the reader sees how
// much of the gap sat where the warning WAS firing (0-1 POs) versus where it was
// suppressed (2+). Only the 2+ bucket is the bug's exposure.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every legitimate
// answer INCLUDING "no rows at all" — that is a finding, not a failure — so a red
// job means the database was unreachable, never that the answer was unwelcome.
// Nothing is inserted to make an answer tidy.
//
// RE-RUN: read-only and stateless. A second run reports whatever is true then.
//
//   DATABASE_URL   required
//   COMPANY_ID     default 1 (Houzs Century)
//   SAMPLE         max example rows to print (default 30)
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error('DATABASE_URL not set (env var or .dev.vars). Aborting.');
  process.exit(1);
}

const CO = Number(process.env.COMPANY_ID ?? 1);
const SAMPLE = Number(process.env.SAMPLE ?? 30);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

try {
  log(`company=${CO}`);
  log('');

  /* One CTE chain, mirroring reviseBoundPo's own bound-set + added-line logic.
     Every predicate here is the engine's: cancelled SO lines dropped, CANCELLED
     POs dropped, service lines excluded (they never become a PO line), the main
     supplier picked is_main_supplier DESC. */
  const rows = await sql`
    WITH so AS (
      SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${CO}
    ),
    so_lines AS (
      SELECT id, doc_no, item_code, item_group
        FROM scm.mfg_sales_order_items
       WHERE doc_no IN (SELECT doc_no FROM so)
         AND COALESCE(cancelled, false) = false
    ),
    bound AS (
      SELECT sl.doc_no, poi.purchase_order_id AS po_id, po.supplier_id
        FROM so_lines sl
        JOIN scm.purchase_order_items poi ON poi.so_item_id = sl.id
        JOIN scm.purchase_orders po        ON po.id = poi.purchase_order_id
       WHERE UPPER(COALESCE(po.status, '')) <> 'CANCELLED'
       GROUP BY sl.doc_no, poi.purchase_order_id, po.supplier_id
    ),
    po_counts AS (
      SELECT doc_no, COUNT(*) AS live_po_count FROM bound GROUP BY doc_no
    ),
    add_codes AS (
      SELECT a.so_doc_no AS doc_no, UPPER(TRIM(al.new_item_code)) AS item_code
        FROM scm.so_amendments a
        JOIN scm.so_amendment_lines al ON al.amendment_id = a.id
       WHERE UPPER(TRIM(al.change_type)) = 'ADD'
         AND al.new_item_code IS NOT NULL
       GROUP BY a.so_doc_no, UPPER(TRIM(al.new_item_code))
    ),
    main_binding AS (
      SELECT DISTINCT ON (UPPER(TRIM(item_code)))
             UPPER(TRIM(item_code)) AS item_code, supplier_id
        FROM scm.supplier_material_bindings
       WHERE company_id = ${CO} AND material_kind = 'mfg_product'
       ORDER BY UPPER(TRIM(item_code)), is_main_supplier DESC, id
    ),
    uncovered AS (   -- current non-service SO lines with no live covering PO line
      SELECT sl.doc_no, sl.id, sl.item_code
        FROM so_lines sl
       WHERE UPPER(COALESCE(sl.item_code, '')) NOT LIKE 'SVC-%'
         AND COALESCE(sl.item_group, '') NOT ILIKE '%service%'
         AND NOT EXISTS (
           SELECT 1 FROM scm.purchase_order_items poi
             JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
            WHERE poi.so_item_id = sl.id
              AND UPPER(COALESCE(po.status, '')) <> 'CANCELLED'
         )
    ),
    added_uncovered AS (   -- uncovered AND amendment-added
      SELECT u.doc_no, u.id, u.item_code,
             COALESCE(pc.live_po_count, 0) AS live_po_count,
             mb.supplier_id AS bound_supplier_id
        FROM uncovered u
        JOIN add_codes ac ON ac.doc_no = u.doc_no
                         AND ac.item_code = UPPER(TRIM(u.item_code))
        LEFT JOIN po_counts pc ON pc.doc_no = u.doc_no
        LEFT JOIN main_binding mb ON mb.item_code = UPPER(TRIM(u.item_code))
    ),
    classified AS (   -- would the warning fire? (no binding, or supplier owns no live PO here)
      SELECT au.*,
             CASE
               WHEN au.bound_supplier_id IS NULL THEN 'no supplier bound'
               WHEN NOT EXISTS (
                 SELECT 1 FROM bound b
                  WHERE b.doc_no = au.doc_no AND b.supplier_id = au.bound_supplier_id
               ) THEN 'supplier has no open PO here'
               ELSE 'supplier owns a live PO here (covered on its confirm)'
             END AS verdict
        FROM added_uncovered au
    )
    SELECT
      (SELECT COUNT(*) FROM so)                                              AS so_total,
      (SELECT COUNT(*) FROM po_counts WHERE live_po_count >= 2)             AS so_multi_po,
      (SELECT COUNT(*) FROM po_counts WHERE live_po_count = 1)              AS so_one_po,
      (SELECT COUNT(DISTINCT doc_no) FROM classified
         WHERE live_po_count >= 2)                                          AS exp_upper_so,
      (SELECT COUNT(*) FROM classified WHERE live_po_count >= 2)            AS exp_upper_lines,
      (SELECT COUNT(DISTINCT doc_no) FROM classified
         WHERE live_po_count >= 2
           AND verdict <> 'supplier owns a live PO here (covered on its confirm)') AS exp_gap_so,
      (SELECT COUNT(*) FROM classified
         WHERE live_po_count >= 2
           AND verdict <> 'supplier owns a live PO here (covered on its confirm)') AS exp_gap_lines,
      (SELECT COUNT(*) FROM classified
         WHERE live_po_count = 1
           AND verdict <> 'supplier owns a live PO here (covered on its confirm)') AS gap_one_po_lines,
      (SELECT COUNT(*) FROM classified
         WHERE live_po_count = 0
           AND verdict <> 'supplier owns a live PO here (covered on its confirm)') AS gap_zero_po_lines
  `;
  const r = rows[0];
  log(`company-${CO} sales orders, total:                         ${r.so_total}`);
  log(`  with 1 live bound purchase order:                        ${r.so_one_po}`);
  log(`  with 2+ live bound purchase orders (P — warning could not fire): ${r.so_multi_po}`);
  log('');
  log('AMENDMENT-ADDED LINE WITH NO COVERING PURCHASE ORDER, on a 2+-PO sales order:');
  log(`  sales orders affected (upper bound):                     ${r.exp_upper_so}`);
  log(`  lines affected (upper bound):                            ${r.exp_upper_lines}`);
  log(`  of those, lines the WARNING would fire on (E_gap):       ${r.exp_gap_lines}  across ${r.exp_gap_so} sales order(s)`);
  log('  (E_gap = no supplier bound, or the supplier owns none of this SO\'s live POs —');
  log('   the exact condition so-revision.ts warns on, suppressed pre-fix by 2+ POs.)');
  log('');
  log('For contrast, the SAME gap where the warning DID already fire:');
  log(`  on a 1-live-PO sales order:                              ${r.gap_one_po_lines} line(s)`);
  log(`  on a 0-live-PO sales order (never a bound-PO confirm):   ${r.gap_zero_po_lines} line(s)`);
  log('');

  if (Number(r.exp_upper_lines) === 0) {
    log('No amendment-added uncovered line sits on a 2+-PO sales order right now, so');
    log('nothing is silently unbought by THIS mechanism at this instant. The fix still');
    log('closes the path — the warning fires the next time this shape occurs.');
  } else {
    const sample = await sql`
      WITH so AS (SELECT doc_no FROM scm.mfg_sales_orders WHERE company_id = ${CO}),
      so_lines AS (
        SELECT id, doc_no, item_code, item_group FROM scm.mfg_sales_order_items
         WHERE doc_no IN (SELECT doc_no FROM so) AND COALESCE(cancelled,false)=false
      ),
      bound AS (
        SELECT sl.doc_no, poi.purchase_order_id AS po_id, po.supplier_id
          FROM so_lines sl
          JOIN scm.purchase_order_items poi ON poi.so_item_id = sl.id
          JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
         WHERE UPPER(COALESCE(po.status,'')) <> 'CANCELLED'
         GROUP BY sl.doc_no, poi.purchase_order_id, po.supplier_id
      ),
      po_counts AS (SELECT doc_no, COUNT(*) AS n FROM bound GROUP BY doc_no),
      add_codes AS (
        SELECT a.so_doc_no AS doc_no, UPPER(TRIM(al.new_item_code)) AS item_code
          FROM scm.so_amendments a JOIN scm.so_amendment_lines al ON al.amendment_id=a.id
         WHERE UPPER(TRIM(al.change_type))='ADD' AND al.new_item_code IS NOT NULL
         GROUP BY a.so_doc_no, UPPER(TRIM(al.new_item_code))
      ),
      main_binding AS (
        SELECT DISTINCT ON (UPPER(TRIM(item_code))) UPPER(TRIM(item_code)) AS item_code, supplier_id
          FROM scm.supplier_material_bindings
         WHERE company_id=${CO} AND material_kind='mfg_product'
         ORDER BY UPPER(TRIM(item_code)), is_main_supplier DESC, id
      )
      SELECT u.doc_no, u.item_code, pc.n AS live_po_count,
             CASE WHEN mb.supplier_id IS NULL THEN 'no supplier bound'
                  WHEN NOT EXISTS (SELECT 1 FROM bound b WHERE b.doc_no=u.doc_no AND b.supplier_id=mb.supplier_id)
                    THEN 'supplier has no open PO here'
                  ELSE 'covered on sibling confirm' END AS verdict
        FROM so_lines u
        JOIN add_codes ac ON ac.doc_no=u.doc_no AND ac.item_code=UPPER(TRIM(u.item_code))
        JOIN po_counts pc ON pc.doc_no=u.doc_no AND pc.n>=2
        LEFT JOIN main_binding mb ON mb.item_code=UPPER(TRIM(u.item_code))
       WHERE UPPER(COALESCE(u.item_code,'')) NOT LIKE 'SVC-%'
         AND COALESCE(u.item_group,'') NOT ILIKE '%service%'
         AND NOT EXISTS (
           SELECT 1 FROM scm.purchase_order_items poi JOIN scm.purchase_orders po ON po.id=poi.purchase_order_id
            WHERE poi.so_item_id=u.id AND UPPER(COALESCE(po.status,'')) <> 'CANCELLED')
       ORDER BY (CASE WHEN mb.supplier_id IS NULL OR NOT EXISTS
                   (SELECT 1 FROM bound b WHERE b.doc_no=u.doc_no AND b.supplier_id=mb.supplier_id)
                 THEN 0 ELSE 1 END), u.doc_no
       LIMIT ${SAMPLE}`;
    log(`sample (up to ${SAMPLE}), gap rows first:`);
    for (const s of sample) {
      log(`  ${s.doc_no}  ${s.item_code}  (${s.live_po_count} live POs)  ${s.verdict}`);
    }
  }
} catch (err) {
  console.error(`query failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
