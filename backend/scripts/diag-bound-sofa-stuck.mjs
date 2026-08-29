#!/usr/bin/env node
// Classify the reconcile lens's "fully-received BOUND dedications still not
// READY" list (35 sofa piece lines on 2026-08-29) into its real causes.
//
// Two已证 sub-populations from the book snapshot (round ledger 4h trace):
//   SO-003295 / SO-009585  were DELIVERED in the book — their mirror DOs mark
//                          the pieces delivered, the allocator rightly leaves
//                          them alone, and the LENS forgot to exclude
//                          delivered lines;
//   SO-004725 / SO-008942  have NO delivery — genuinely stuck.
// This probe measures every flagged line so the fix lands on the right side:
// per line it prints the SO's status + processing date, the line's status and
// deliverable arithmetic (qty − delivered + returned, via mirror/real DO
// lines), and its dedicated PO lines (number, received, qty). CLASS:
//   DELIVERED   — deliverable remaining 0: the lens must exclude it
//   GATED       — order not PROCESSED / no processing date: allocator skips by design
//   STUCK       — remaining > 0, received > 0, order processed: the allocator
//                 owes this line a light and does not deliver one — real defect
// Read-only; exit 0 for every verdict.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

async function main() {
  // the same lens the reconcile check uses: bound-group lines whose dedicated
  // PO lines are fully received, line not READY
  const rows = await sql`
    SELECT h.doc_no, h.status::text AS so_status,
           to_char(h.processing_date, 'YYYY-MM-DD') AS pdate,
           i.id, i.item_code, i.item_group, i.qty, i.stock_status,
           COALESCE(SUM(p.received_qty), 0) AS recv,
           COALESCE(SUM(p.qty), 0) AS po_qty,
           array_agg(DISTINCT po.po_number) AS pos
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items p ON p.so_item_id = i.id
    JOIN scm.purchase_orders po ON po.id = p.purchase_order_id
    WHERE h.company_id = 1 AND h.linked_ac_docno IS NOT NULL
      AND i.cancelled = false AND LOWER(i.item_group) IN ('sofa', 'bedframe')
      AND UPPER(h.status::text) NOT IN ('CANCELLED', 'COMPLETED')
      AND i.stock_status <> 'READY'
    GROUP BY h.doc_no, h.status, h.processing_date, i.id, i.item_code, i.item_group, i.qty, i.stock_status
    HAVING COALESCE(SUM(p.received_qty), 0) >= COALESCE(SUM(p.qty), 0)
       AND COALESCE(SUM(p.received_qty), 0) > 0`;
  log(`lens-flagged bound lines not READY: ${rows.length}`);

  const ids = rows.map((r) => r.id);
  const delivered = ids.length
    ? await sql`SELECT d.so_item_id, SUM(d.qty) AS dq
        FROM scm.delivery_order_items d
        JOIN scm.delivery_orders h ON h.id = d.delivery_order_id
        WHERE d.so_item_id = ANY(${ids}) AND COALESCE(h.status::text, '') NOT ILIKE '%cancel%'
        GROUP BY d.so_item_id`
    : [];
  const dq = new Map(delivered.map((r) => [r.so_item_id, Number(r.dq)]));

  const counts = { DELIVERED: 0, GATED: 0, STUCK: 0 };
  for (const r of rows) {
    const del = dq.get(r.id) ?? 0;
    const remaining = Number(r.qty) - del;
    const cls = remaining <= 0 ? "DELIVERED"
      : (!r.pdate || String(r.so_status).toUpperCase() !== "PROCESSED" && String(r.so_status).toUpperCase() !== "CONFIRMED") ? "GATED"
      : "STUCK";
    counts[cls]++;
    log(`  ${cls.padEnd(9)} ${r.doc_no} ${String(r.item_code).padEnd(16)} status=${r.stock_status} so=${r.so_status} pdate=${r.pdate ?? "-"} qty=${r.qty} recv=${r.recv}/${r.po_qty} delivered=${del} via ${(r.pos ?? []).join(",")}`);
  }
  log(`CLASSES: DELIVERED(lens must exclude)=${counts.DELIVERED}  GATED(by design)=${counts.GATED}  STUCK(real defect)=${counts.STUCK}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
