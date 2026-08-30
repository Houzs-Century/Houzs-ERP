#!/usr/bin/env node
/* One-shot READ-ONLY probe behind the owner's 2026-08-30 Sales Report review
 * (2990, company 2). Five questions, each printed as its own section:
 *   A. DO-2607-021 — why is its DO cost blank while sibling legacy DOs fall
 *      back to the SO estimate? (line-level unit_cost/ship_cost dump + its
 *      SO lines' costs)
 *   B. The accessories DOs whose SO AMOUNT shows nothing — are their SOs
 *      genuinely zero-amount (FOC), or did the header lookup miss?
 *   C. The two branding-blank rows — what do their SO lines' catalog
 *      categories resolve to?
 *   D. "很多单没进得来" — census: every 2990 DO by its SO's status; the
 *      report only anchors on status=CONFIRMED SOs.
 *   E. SO-tab zero-cost census — confirmed 2990 SOs whose total_cost_sen=0,
 *      and which of their item codes have NO cost in product maintenance
 *      (feeds the approved backfill tool).
 * SELECT only. Exit 0 for every legitimate answer.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });
const CO = 2;
const sen = (v) => (Number(v ?? 0) / 100).toFixed(2);

// ── A. DO-2607-021 vs a healthy legacy sibling ─────────────────────────────
for (const doNo of ["2990-DO-2607-021", "2990-DO-2607-007"]) {
  const [d] = await sql`SELECT id, do_number, so_doc_no, status FROM scm.delivery_orders WHERE company_id=${CO} AND do_number=${doNo}`;
  if (!d) { console.log(`A. ${doNo}: NOT FOUND`); continue; }
  const lines = await sql`SELECT item_code, qty, unit_cost_sen, ship_cost_sen, so_item_id IS NOT NULL AS linked
    FROM scm.delivery_order_items WHERE delivery_order_id=${d.id}`;
  console.log(`A. ${doNo} (SO ${d.so_doc_no}, ${d.status}) lines:`);
  for (const l of lines) console.log(`   ${l.item_code} x${l.qty} unit_cost=${l.unit_cost_sen == null ? "NULL" : sen(l.unit_cost_sen)} ship_cost=${l.ship_cost_sen == null ? "NULL" : sen(l.ship_cost_sen)} so-linked=${l.linked}`);
  const so = await sql`SELECT item_code, qty, unit_cost_sen, line_cost_sen, created_at::date AS created, updated_at::date AS updated
    FROM scm.mfg_sales_order_items WHERE doc_no=${d.so_doc_no} AND cancelled=false`;
  console.log(`   its SO lines:`);
  for (const l of so) console.log(`   ${l.item_code} x${l.qty} unit_cost=${l.unit_cost_sen == null ? "NULL" : sen(l.unit_cost_sen)} created=${l.created} updated=${l.updated}`);
}

// ── B. the zero-amount SOs behind the accessories DOs ──────────────────────
{
  const docs = ["2990-SO-2606-027", "2990-SO-2606-032", "2990-SO-2606-031", "2990-SO-2606-028", "2990-SO-2606-035", "2990-SO-2607-007"];
  const rows = await sql`SELECT doc_no, status, local_total_sen, total_revenue_sen, service_sen, total_cost_sen
    FROM scm.mfg_sales_orders WHERE company_id=${CO} AND doc_no = ANY(${docs})`;
  console.log(`\nB. the accessories DOs' SO headers:`);
  for (const r of rows) console.log(`   ${r.doc_no} status=${r.status} local_total=${sen(r.local_total_sen)} revenue=${sen(r.total_revenue_sen)} service=${sen(r.service_sen)} so_cost=${sen(r.total_cost_sen)}`);
}

// ── C. branding-blank rows: what do the SO lines' categories resolve to? ───
{
  for (const docNo of ["2990-SO-2606-009", "2990-SO-2607-011"]) {
    const lines = await sql`SELECT i.item_code, i.item_group, p.category AS catalog_category
      FROM scm.mfg_sales_order_items i
      LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = ${CO}
      WHERE i.doc_no=${docNo} AND i.cancelled=false ORDER BY i.line_no NULLS LAST, i.created_at`;
    console.log(`\nC. ${docNo} lines (branding derives from the first item's catalog category):`);
    for (const l of lines) console.log(`   ${l.item_code} group=${l.item_group ?? "-"} catalog=${l.catalog_category ?? "NOT IN CATALOG"}`);
  }
}

// ── D. why DOs are missing from the tab: SO-status census over ALL 2990 DOs ─
{
  const rows = await sql`SELECT COALESCE(h.status::text, '(SO not found)') AS so_status, COUNT(*)::int AS dos
    FROM scm.delivery_orders d
    LEFT JOIN scm.mfg_sales_orders h ON h.doc_no = d.so_doc_no
    WHERE d.company_id=${CO}
    GROUP BY 1 ORDER BY 2 DESC`;
  console.log(`\nD. every 2990 DO by its SO's status (the report shows ONLY status=CONFIRMED SOs):`);
  for (const r of rows) console.log(`   SO ${r.so_status}: ${r.dos} DO(s)`);
  const [tot] = await sql`SELECT COUNT(*)::int AS n FROM scm.delivery_orders WHERE company_id=${CO}`;
  console.log(`   total 2990 DOs: ${tot.n}`);
}

// ── E. zero-cost confirmed SOs + which codes lack product cost ─────────────
{
  const [hdr] = await sql`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_orders
    WHERE company_id=${CO} AND status='CONFIRMED' AND COALESCE(total_cost_sen,0)=0 AND COALESCE(local_total_sen,0)>0`;
  console.log(`\nE. confirmed 2990 SOs with revenue but ZERO total cost: ${hdr.n}`);
  const codes = await sql`SELECT i.item_code, COUNT(*)::int AS zero_lines,
      MAX(COALESCE(p.cost_price_sen,0))::int AS product_cost_now
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
    LEFT JOIN scm.mfg_products p ON p.code=i.item_code AND p.company_id=${CO}
    WHERE h.company_id=${CO} AND h.status='CONFIRMED' AND i.cancelled=false
      AND COALESCE(i.unit_cost_sen,0)=0 AND COALESCE(i.unit_price_sen,0)>0
      AND lower(COALESCE(i.item_group,'')) NOT IN ('service')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 20`;
  console.log(`   top zero-cost line codes (zero_lines / product cost TODAY):`);
  for (const r of codes) console.log(`   ${r.item_code}: ${r.zero_lines} line(s), product cost now RM ${sen(r.product_cost_now)}${Number(r.product_cost_now) === 0 ? "  <- still no cost in maintenance" : "  <- FILLED, backfill would heal"}`);
}

await sql.end();
