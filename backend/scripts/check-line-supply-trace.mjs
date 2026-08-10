#!/usr/bin/env node
// For every open sales-order line: is it READY, and if it is NOT, WHICH purchase
// order is it waiting on and WHEN does that PO arrive.
//
// Owner 2026-08-10: "不 ready 的是什么 PO、几时到？然后我出 DO 的时候，要能看得到
// 对应的是什么 PO。这些信息都要准确."
//
// The answer comes from two different places depending on the line, and saying
// which is which is the point of this report:
//
//   BOUND (bedframe / sofa) — the line has its OWN purchase order, linked by
//     purchase_order_items.so_item_id. That is a hard link, not a guess: the
//     goods on that PO were bought for this line. Its delivery_date is the ETA.
//   POOLED (mattress / accessories) — no dedication. The line draws from shared
//     stock, so "which PO" is only answerable once a lot is consumed, and until
//     then the honest answer is the earliest open PO carrying that item.
//
// Read-only.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;

async function main() {
  log("═══ 1. Open lines by readiness, split by allocation model ═══");
  const st = await sql`SELECT
      CASE WHEN i.item_group IN ('bedframe','sofa') THEN 'bound' ELSE 'pooled' END AS model,
      i.stock_status, COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
    GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
  for (const r of st) log(`   ${r.model} ${r.stock_status ?? "(null)"}: ${r.n}`);

  log("");
  log("═══ 2. BOUND lines that are not READY — the PO they wait on, and its date ═══");
  const bound = await sql`SELECT i.doc_no, i.item_code, i.qty, i.stock_status,
      p.po_number, p.status AS po_status, poi.received_qty,
      COALESCE(poi.delivery_date, p.expected_at::date) AS eta
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY'
    ORDER BY eta NULLS LAST, i.doc_no LIMIT 400`;
  const noEta = bound.filter((r) => !r.eta).length;
  log(`bound lines not READY that DO have a PO: ${bound.length}; of those with no date on the PO: ${noEta}`);
  for (const r of bound.slice(0, 25)) {
    log(`   ${r.doc_no} ${r.item_code} [${r.stock_status}] <- ${r.po_number} (${r.po_status}) recv ${r.received_qty}/${r.qty} eta ${r.eta ?? "NONE"}`);
  }

  /* A bound line with NO purchase order at all is the one a buyer has to act on:
     nothing has been ordered for it, so no date exists to show. It must be
     visible as its own number, not hidden inside "not ready". */
  const [{ n: boundNoPo }] = await sql`SELECT COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY' AND poi.id IS NULL`;
  log(`bound lines not READY with NO purchase order raised at all: ${boundNoPo} (these need a buyer, not a date)`);

  log("");
  log("═══ 3. POOLED lines not READY — the earliest open PO carrying that item ═══");
  const pooled = await sql`WITH need AS (
      SELECT i.item_code, COUNT(*)::int lines, SUM(i.qty)::int qty
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
        AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
        AND i.item_group NOT IN ('bedframe','sofa','service') AND i.stock_status <> 'READY'
      GROUP BY 1)
    SELECT n.item_code, n.lines, n.qty,
      (SELECT p.po_number FROM scm.purchase_order_items poi
         JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
        WHERE poi.material_code = n.item_code AND p.company_id = ${CO}
          AND p.status NOT IN ('CANCELLED','CLOSED','DRAFT')
          AND COALESCE(poi.received_qty,0) < poi.qty
        ORDER BY COALESCE(poi.delivery_date, p.expected_at::date) NULLS LAST LIMIT 1) AS next_po,
      (SELECT COALESCE(poi.delivery_date, p.expected_at::date) FROM scm.purchase_order_items poi
         JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
        WHERE poi.material_code = n.item_code AND p.company_id = ${CO}
          AND p.status NOT IN ('CANCELLED','CLOSED','DRAFT')
          AND COALESCE(poi.received_qty,0) < poi.qty
        ORDER BY COALESCE(poi.delivery_date, p.expected_at::date) NULLS LAST LIMIT 1) AS eta
    FROM need n ORDER BY n.qty DESC LIMIT 30`;
  const covered = pooled.filter((r) => r.next_po).length;
  log(`item codes short: ${pooled.length} shown (top by quantity); with an open PO on the way: ${covered}`);
  for (const r of pooled.slice(0, 20)) {
    log(`   ${r.item_code}: ${r.lines} line(s) / ${r.qty} unit(s) -> ${r.next_po ?? "NO OPEN PO"} ${r.eta ? "eta " + String(r.eta).slice(0, 10) : ""}`);
  }

  log("");
  log("═══ 4. Can a DO see its source PO? ═══");
  /* The DO screen resolves the source PO from the line's dedication first, and
     from the consumed lot's batch second. Count how many open lines can be
     answered by each, because a line answerable by neither shows a dash. */
  const [ans] = await sql`SELECT
      COUNT(*)::int open_lines,
      COUNT(*) FILTER (WHERE poi.id IS NOT NULL)::int by_dedication,
      COUNT(*) FILTER (WHERE poi.id IS NULL AND i.item_group IN ('bedframe','sofa'))::int bound_unanswerable
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')`;
  log(`open lines: ${ans.open_lines}; answerable from the SO-PO dedication: ${ans.by_dedication}; bound lines with no dedication (would show a dash): ${ans.bound_unanswerable}`);
  const [{ n: lotsWithBatch }] = await sql`SELECT COUNT(*)::int n FROM scm.inventory_lots
    WHERE company_id = ${CO} AND batch_no IS NOT NULL AND qty_remaining > 0`;
  const [{ n: lotsTotal }] = await sql`SELECT COUNT(*)::int n FROM scm.inventory_lots
    WHERE company_id = ${CO} AND qty_remaining > 0`;
  log(`open stock lots: ${lotsTotal}; carrying a batch_no (so a shipped line can name its PO): ${lotsWithBatch}`);

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
