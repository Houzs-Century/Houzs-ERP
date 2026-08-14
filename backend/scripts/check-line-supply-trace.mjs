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
  /* Printed as evidence, not decoration: this script crashed on 2026-08-10 with
     `invalid input value for enum scm.po_status: "CLOSED"` because section 3
     filtered on a value that is not a member. The enum is ground truth in the
     DB, not in the repo (0042 re-added DRAFT after 2990's 0078 removed it), so
     the report states what the live members ARE. Every po_status comparison
     below is also cast to text, so an unknown member can never crash a
     read-only diagnostic again. */
  const [{ members: poStatusMembers }] = await sql`SELECT enum_range(NULL::scm.po_status)::text AS members`;
  log(`scm.po_status members: ${poStatusMembers}`);

  log("");
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
  /* `recv X/Y` used to print poi.received_qty over i.qty — the PO LINE's receipt
     against the SO LINE's quantity, two different quantities. That produced
     lines like "recv 2/1" that read as an over-receipt but are nothing of the
     sort when one PO line covers several SO lines. Print the PO line's own
     ordered qty, and keep the SO line's qty beside it. */
  const bound = await sql`SELECT i.doc_no, i.item_code, i.qty AS so_qty, i.stock_status,
      p.po_number, p.status::text AS po_status, poi.qty AS po_qty, COALESCE(poi.received_qty,0) AS received_qty,
      COALESCE(poi.delivery_date, p.expected_at::date) AS eta
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY'
    ORDER BY eta NULLS LAST, i.doc_no LIMIT 400`;
  /* The list above is LIMIT 400 for printing; the HEADLINE number must be the
     real one, counted over the whole set and DISTINCT on the SO line (a line can
     have several dedicated PO lines, which the join multiplies). */
  const [boundWithPo] = await sql`SELECT COUNT(DISTINCT i.id)::int lines,
      COUNT(DISTINCT i.id) FILTER (WHERE COALESCE(poi.delivery_date, p.expected_at::date) IS NULL)::int no_eta,
      COUNT(*)::int join_rows
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY'`;
  log(`bound lines not READY that DO have a PO: ${boundWithPo.lines} (${boundWithPo.join_rows} SO-line x PO-line pairs); of those with no date on any dedicated PO line: ${boundWithPo.no_eta}`);
  for (const r of bound.slice(0, 25)) {
    log(`   ${r.doc_no} ${r.item_code} [${r.stock_status}] <- ${r.po_number} (${r.po_status}) PO line recv ${r.received_qty}/${r.po_qty}, SO line qty ${r.so_qty}, eta ${r.eta ?? "NONE"}`);
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
  /* Sanity check the two numbers add up to the bound-not-READY population, so
     the "no PO at all" figure can be trusted rather than assumed. */
  const [{ n: boundNotReady }] = await sql`SELECT COUNT(*)::int n
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY'`;
  log(`   check: bound not READY total ${boundNotReady} = with a PO ${boundWithPo.lines} + without ${boundNoPo} -> ${boundWithPo.lines + boundNoPo === boundNotReady ? "adds up" : "DOES NOT ADD UP"}`);
  const noPoSplit = await sql`SELECT i.item_group, i.stock_status::text stock_status, COUNT(*)::int n,
      COUNT(DISTINCT i.doc_no)::int orders
    FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY' AND poi.id IS NULL
    GROUP BY 1,2 ORDER BY 3 DESC`;
  for (const r of noPoSplit) log(`   no-PO split: ${r.item_group} ${r.stock_status} = ${r.n} line(s) across ${r.orders} order(s)`);

  log("");
  log("═══ 3. POOLED lines not READY — the earliest open PO carrying that item ═══");
  /* 'CLOSED' was in this filter until 2026-08-10 and is NOT a member of
     scm.po_status (see the members printed at the top), so the whole section
     aborted with 22P02. A fully-received PO line is already excluded by the
     received_qty < qty predicate, so dropping CLOSED changes no semantics. */
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
          AND p.status::text NOT IN ('CANCELLED','DRAFT')
          AND COALESCE(poi.received_qty,0) < poi.qty
        ORDER BY COALESCE(poi.delivery_date, p.expected_at::date) NULLS LAST LIMIT 1) AS next_po,
      (SELECT COALESCE(poi.delivery_date, p.expected_at::date) FROM scm.purchase_order_items poi
         JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
        WHERE poi.material_code = n.item_code AND p.company_id = ${CO}
          AND p.status::text NOT IN ('CANCELLED','DRAFT')
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

  log("");
  log("═══ 5. OVER-RECEIPT — is `recv 2/1` a real over-receipt or a reporting artefact? ═══");
  /* received_qty lives on the PO LINE and is a running total across every GRN
     against that line. The only honest test of over-receipt is received_qty vs
     the SAME line's qty. Comparing it against the SO line's qty (what section 2
     used to print) is a category error whenever one PO line covers several SO
     lines, or a PO line was ordered in a larger quantity than one SO needs. */
  const [ovr] = await sql`SELECT COUNT(*)::int lines,
      COUNT(*) FILTER (WHERE COALESCE(poi.received_qty,0) > poi.qty)::int over_received,
      COALESCE(SUM(GREATEST(COALESCE(poi.received_qty,0) - poi.qty, 0)),0)::numeric over_units
    FROM scm.purchase_order_items poi JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE p.company_id = ${CO}`;
  log(`PO lines company-wide: ${ovr.lines}; with received_qty > that line's own qty (a REAL over-receipt): ${ovr.over_received}; excess units: ${ovr.over_units}`);
  const ovrRows = await sql`SELECT p.po_number, p.status::text po_status, poi.material_code, poi.qty, COALESCE(poi.received_qty,0) received_qty
    FROM scm.purchase_order_items poi JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE p.company_id = ${CO} AND COALESCE(poi.received_qty,0) > poi.qty
    ORDER BY (COALESCE(poi.received_qty,0) - poi.qty) DESC, p.po_number LIMIT 20`;
  for (const r of ovrRows) log(`   ${r.po_number} (${r.po_status}) ${r.material_code}: ordered ${r.qty}, received ${r.received_qty}`);

  /* Same population section 2 prints, scored both ways: how many of those rows
     LOOK over-received under the old comparison, and how many actually are. */
  const [look] = await sql`SELECT COUNT(*)::int rows,
      COUNT(*) FILTER (WHERE COALESCE(poi.received_qty,0) > i.qty)::int looks_over_vs_so_line,
      COUNT(*) FILTER (WHERE COALESCE(poi.received_qty,0) > poi.qty)::int truly_over_vs_po_line
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE h.company_id = ${CO} AND COALESCE(i.cancelled,false) = false
      AND h.status NOT IN ('CANCELLED','CLOSED','DELIVERED','SHIPPED','INVOICED')
      AND i.item_group IN ('bedframe','sofa') AND i.stock_status <> 'READY'`;
  log(`section 2 population: ${look.rows} pair(s); look over-received against the SO line qty: ${look.looks_over_vs_so_line}; genuinely over-received against their own PO line qty: ${look.truly_over_vs_po_line}`);

  /* The line the owner asked about, printed raw so the arithmetic is checkable.
     Overridable so the next question about a different order needs no edit. */
  const PROBE_SO = process.env.PROBE_SO || "HC-SO-011957";
  const probe = await sql`SELECT i.doc_no, i.item_code, i.qty so_qty, i.stock_status::text stock_status,
      p.po_number, p.status::text po_status, poi.qty po_qty, COALESCE(poi.received_qty,0) received_qty,
      (SELECT COUNT(*)::int FROM scm.purchase_order_items x WHERE x.purchase_order_id = poi.purchase_order_id) po_line_count,
      (SELECT COUNT(*)::int FROM scm.purchase_order_items z WHERE z.so_item_id = i.id) po_lines_for_this_so_line
    FROM scm.mfg_sales_order_items i
    JOIN scm.purchase_order_items poi ON poi.so_item_id = i.id
    JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
    WHERE i.doc_no = ${PROBE_SO}`;
  if (!probe.length) log(`probe ${PROBE_SO}: no dedicated PO line found`);
  for (const r of probe) {
    log(`probe ${r.doc_no} ${r.item_code} [${r.stock_status}] SO qty ${r.so_qty} <- ${r.po_number} (${r.po_status}) PO line qty ${r.po_qty} received ${r.received_qty}; that PO has ${r.po_line_count} line(s); this SO line has ${r.po_lines_for_this_so_line} dedicated PO line(s)`);
  }
  const probePos = [...new Set(probe.map((r) => r.po_number))];
  if (probePos.length) {
    const grnProbe = await sql`SELECT p.po_number, g.grn_number, g.status::text grn_status,
        gi.material_code, gi.qty_received, gi.qty_accepted, g.received_at
      FROM scm.grn_items gi
      JOIN scm.grns g ON g.id = gi.grn_id
      JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
      JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE p.company_id = ${CO} AND p.po_number = ANY(${probePos})
      ORDER BY g.received_at`;
    for (const r of grnProbe) log(`   ${r.po_number} receipt: ${r.grn_number} (${r.grn_status}) ${r.material_code} received ${r.qty_received} accepted ${r.qty_accepted} on ${String(r.received_at).slice(0, 10)}`);
    if (!grnProbe.length) log(`   ${probePos.join(", ")}: no GRN line rows in the ERP — received_qty on the PO line came from the AutoCount import, not from an ERP receipt`);
  }

  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
