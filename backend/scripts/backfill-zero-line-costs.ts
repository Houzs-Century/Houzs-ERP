#!/usr/bin/env node
// ----------------------------------------------------------------------------
// backfill-zero-line-costs — give a ZERO-cost sales-order line the cost its
// product carries in Product Maintenance TODAY, then re-roll the order's
// header totals through the SYSTEM'S OWN function.
//
// WHY. Owner, 2026-08-30: 「这种零的,如果当我的 Product Maintenance 填上了价钱,
// 它会直接自动 backfill 吗?」 — no, and by design: the cost on a line is a
// SNAPSHOT taken when the line was written (routes/mfg-sales-orders.ts, "Cost
// snapshot": explicit client value > server recompute > mfg_products
// .cost_price_sen > 0). A snapshot is the right model — a price rise next year
// must not rewrite last year's margin — but it leaves every line that was
// written while the catalog had no cost sitting at zero forever, and the Sales
// Report then shows 100% margin. He chose option 甲: a one-shot, re-runnable
// tool that fills ONLY the zeros.
//
// WHAT IT WRITES, and what it refuses to write:
//   · unit_cost_sen / line_cost_sen on lines whose CURRENT unit cost is 0 and
//     whose product now has a cost. Everything else is untouched — a line that
//     already carries a cost is never re-priced, so a real snapshot can never
//     be overwritten by today's catalog.
//   · the header roll-up, by calling the route's OWN `recomputeTotals` (the
//     category cost buckets, total_cost_sen, margin, and the sofa combo spread
//     it owns). NOT re-implemented here: a second copy of that arithmetic is
//     exactly the drift this repo keeps paying for.
//   · SERVICE lines are excluded (their cost is legitimately 0), as are
//     cancelled lines and cancelled/draft orders.
//
// SINCE (optional) limits the write to orders on/after a date, for the owner's
// "very old orders may have had a different cost then" concern. Default: all.
//
//   DATABASE_URL   required
//   COMPANY        company id (default 1)
//   SINCE          YYYY-MM-DD — only orders with so_date >= this (default: all)
//   MODE           plan (default) | apply
//   CONFIRM        on apply, must be exactly: BACKFILL ZERO LINE COSTS
//
// RE-RUN: convergent. A second run finds nothing to do — the lines it filled
// are no longer zero, and it never touches a non-zero line. Re-run it after
// every batch of Product Maintenance edits.
// ----------------------------------------------------------------------------
import postgres from 'postgres';
// @ts-expect-error - plain .mjs helper, no types
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { recomputeTotals } from '../src/scm/routes/mfg-sales-orders';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const COMPANY = Number(process.env.COMPANY ?? 1);
const SINCE = (process.env.SINCE ?? '').trim() || null;
const MODE = (process.env.MODE ?? 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
const CONFIRM_PHRASE = 'BACKFILL ZERO LINE COSTS';
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen: number) => (sen / 100).toFixed(2);

if (APPLY && (process.env.CONFIRM ?? '').trim() !== CONFIRM_PHRASE) {
  console.error(`REFUSED: apply needs CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });
/* The roll-up reads the company off the request context; a script has none, so
   hand it the one object shape it actually consults (activeCompanyId → get). */
const ctx = { get: (k: string) => (k === 'companyId' ? COMPANY : undefined) } as never;

type Cand = {
  id: string; doc_no: string; item_code: string; item_group: string | null;
  qty: number; unit_price_sen: number; product_cost_sen: number;
};

async function main() {
  log(`mode=${APPLY ? 'APPLY' : 'PLAN'} company=${COMPANY}${SINCE ? ` since=${SINCE}` : ' (all dates)'}`);

  const cands = await sql<Cand[]>`
    SELECT i.id, i.doc_no, i.item_code, i.item_group,
           COALESCE(i.qty, 0)::int AS qty,
           COALESCE(i.unit_price_sen, 0)::int AS unit_price_sen,
           COALESCE(p.cost_price_sen, 0)::int AS product_cost_sen
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      JOIN scm.mfg_products p ON upper(p.code) = upper(i.item_code) AND p.company_id = h.company_id
     WHERE h.company_id = ${COMPANY}
       AND i.cancelled = false
       AND upper(h.status::text) NOT IN ('CANCELLED', 'DRAFT')
       AND lower(COALESCE(i.item_group, '')) <> 'service'
       AND COALESCE(i.unit_cost_sen, 0) = 0
       AND COALESCE(p.cost_price_sen, 0) > 0
       AND COALESCE(i.qty, 0) > 0
       ${SINCE ? sql`AND h.so_date >= ${SINCE}::date` : sql``}
     ORDER BY i.doc_no, i.item_code`;

  const docs = [...new Set(cands.map((r) => r.doc_no))];
  const totalCost = cands.reduce((a, r) => a + r.product_cost_sen * r.qty, 0);
  log(`zero-cost lines whose product now HAS a cost: ${cands.length} on ${docs.length} order(s); cost to be written RM ${rm(totalCost)}`);
  const byGroup = new Map<string, { n: number; sen: number }>();
  for (const r of cands) {
    const g = (r.item_group ?? '(none)').toLowerCase();
    const e = byGroup.get(g) ?? { n: 0, sen: 0 };
    e.n += 1; e.sen += r.product_cost_sen * r.qty;
    byGroup.set(g, e);
  }
  for (const [g, e] of [...byGroup.entries()].sort((a, b) => b[1].n - a[1].n)) log(`   ${g}: ${e.n} line(s), RM ${rm(e.sen)}`);
  for (const r of cands.slice(0, 12)) log(`   ${r.doc_no} ${r.item_code} x${r.qty} -> unit RM ${rm(r.product_cost_sen)} (sell RM ${rm(r.unit_price_sen)})`);
  if (cands.length > 12) log(`   ... and ${cands.length - 12} more`);

  /* The other half of the owner's question, reported so the number is honest:
     lines still at zero because the PRODUCT still has no cost. Those wait for
     Product Maintenance, and a re-run picks them up. */
  const [waiting] = await sql<Array<{ n: number; codes: number }>>`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT i.item_code)::int AS codes
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      LEFT JOIN scm.mfg_products p ON upper(p.code) = upper(i.item_code) AND p.company_id = h.company_id
     WHERE h.company_id = ${COMPANY} AND i.cancelled = false
       AND upper(h.status::text) NOT IN ('CANCELLED', 'DRAFT')
       AND lower(COALESCE(i.item_group, '')) <> 'service'
       AND COALESCE(i.unit_cost_sen, 0) = 0 AND COALESCE(i.qty, 0) > 0
       AND COALESCE(p.cost_price_sen, 0) = 0`;
  log(`still zero AFTER this run (their product has no cost yet): ${waiting.n} line(s) across ${waiting.codes} item code(s) — fill those in Product Maintenance and re-run`);

  if (!APPLY) { log(`\nPLAN ONLY — MODE=apply CONFIRM="${CONFIRM_PHRASE}" writes.`); await sql.end(); return; }
  if (cands.length === 0) { log('nothing to do.'); await sql.end(); return; }

  let lines = 0;
  for (const r of cands) {
    const unit = r.product_cost_sen;
    const line = unit * r.qty;
    const res = await sql`UPDATE scm.mfg_sales_order_items
        SET unit_cost_sen = ${unit}, line_cost_sen = ${line},
            line_margin_sen = COALESCE(total_sen, 0) - ${line}
      WHERE id = ${r.id} AND COALESCE(unit_cost_sen, 0) = 0
      RETURNING id`;
    lines += res.length;
  }
  log(`lines priced: ${lines} of ${cands.length} planned`);

  /* Header roll-up through the ROUTE'S OWN function over the shim, so the
     category buckets, the sofa combo spread and the margin basis are the
     system's arithmetic, not a copy of it. */
  const shim = pgrestShim(sql);
  let rolled = 0;
  for (const doc of docs) { await recomputeTotals(shim, doc, ctx); rolled += 1; }
  log(`headers re-rolled through recomputeTotals: ${rolled}`);

  /* VERIFY on a FRESH connection, asserting the SHAPE: every planned line now
     carries the product's cost, and its order's header cost is at least the
     sum of its lines (never a stale zero). */
  const v = postgres(url, { ssl: 'require', prepare: false, max: 1 });
  const ids = cands.map((r) => r.id);
  const [chk] = await v<Array<{ zero_left: number; typ: string }>>`
    SELECT COUNT(*) FILTER (WHERE COALESCE(unit_cost_sen, 0) = 0)::int AS zero_left,
           pg_typeof(unit_cost_sen)::text AS typ
      FROM scm.mfg_sales_order_items WHERE id = ANY(${ids}) GROUP BY 2`;
  const [hdr] = await v<Array<{ stale: number }>>`
    SELECT COUNT(*)::int AS stale FROM scm.mfg_sales_orders h
     WHERE h.doc_no = ANY(${docs}) AND COALESCE(h.total_cost_sen, 0) = 0`;
  log(`VERIFY (fresh connection): planned lines still at zero: ${chk?.zero_left ?? 'n/a'}; unit_cost_sen type ${chk?.typ ?? 'n/a'}; headers still showing zero total cost: ${hdr.stale}`);
  if ((chk?.zero_left ?? 1) !== 0) log('VERIFY FAILED — some planned lines did not take the write; investigate before re-running.');
  await v.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
