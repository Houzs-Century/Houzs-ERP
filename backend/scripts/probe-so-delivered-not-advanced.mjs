#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. "Some orders look Delivered but are still in In Production —
// WHY?" (owner, 2026-09-01).
//
// THE RULE ALREADY EXISTS, and saying so is the point of this probe. My first
// answer to him was that shipping never moves the sales order's status. That was
// WRONG: `scm/lib/so-delivery-sync.ts` auto-advances a fully covered SO to
// DELIVERED, and it has for months. I had grepped `delivery-orders-mfg.ts` for
// `.update(` on the SO table, found none, and answered a different question —
// the update lives in the shared module that file calls.
//
// So the real question is not "is there a rule" but "why was this order never
// offered to it". The rule fires when a DELIVERY ORDER changes status. An order
// whose goods are all out but whose DO never reached a status that triggers the
// sync was simply never re-evaluated — and that is a BACKFILL, not a missing
// rule. Only the DO's own status separates the two, so this prints it.
//
// Owner's ruling, already recorded in backfill-2990-delivered-dos.mjs:
//   「我们开了 DO 就是 consider 出货 delivered 了」
//
// COVERAGE IS NETTED OF RETURNS, matching isSoFullyCovered. The first version of
// this probe was not, and a probe that overstates coverage reports orders as
// stuck that are genuinely still short — see docs/bugs/0599-*.
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts, statuses and
// document numbers only.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL   required     COMPANY  a company id or `all` (default all)
//   SHOW           document numbers to name (default 10)
//
// RE-RUN: idempotent and side-effect free.
// ----------------------------------------------------------------------------
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(2); }
const RAW = String(process.env.COMPANY ?? 'all').trim().toLowerCase();
const ALL = RAW === 'all' || RAW === '';
const SHOW = Number(process.env.SHOW ?? 10);
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const SETTLED = ['SHIPPED', 'DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED'];

const sql = postgres(url, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`scope=${ALL ? 'ALL COMPANIES' : `company ${RAW}`}`);
  const companies = ALL
    ? (await sql`SELECT DISTINCT company_id AS id FROM scm.mfg_sales_orders
                  WHERE company_id IS NOT NULL ORDER BY 1`).map((r) => Number(r.id))
    : [Number(RAW)];

  for (const CO of companies) {
    const rows = await sql`
      WITH shipped AS (
        SELECT di.so_item_id, SUM(di.qty)::numeric AS out_qty
          FROM scm.delivery_order_items di
          JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id
         WHERE dh.company_id = ${CO}
           /* The engine's own exclusion set, DO_NOT_DELIVERED_STATES — DRAFT and
              CANCELLED. A Confirmed (LOADED) delivery counts, because its stock
              is already out (shared/do-shipped-states.ts, owner 2026-08-22). */
           AND upper(COALESCE(dh.status::text, '')) NOT IN ('DRAFT', 'CANCELLED')
           AND di.so_item_id IS NOT NULL
         GROUP BY 1
      ), returned AS (
        /* NETTED, and this is what the first version of this probe MISSED.
           isSoFullyCovered subtracts returns: goods brought back mean the order
           owes that quantity again and is no longer delivered (Wei Siang
           2026-06-01, DR 3B). A probe that ignores them OVERSTATES coverage and
           reports orders as stuck that are genuinely still short. */
        SELECT di.so_item_id, SUM(dri.qty_returned)::numeric AS back_qty
          FROM scm.delivery_return_items dri
          JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id
          JOIN scm.delivery_order_items di ON di.id = dri.do_item_id
         WHERE upper(COALESCE(dr.status::text, '')) <> 'CANCELLED'
           AND di.so_item_id IS NOT NULL
         GROUP BY 1
      ), per_line AS (
        SELECT i.doc_no, i.qty::numeric AS ordered,
               COALESCE(s.out_qty, 0) - COALESCE(rt.back_qty, 0) AS out_qty,
               COALESCE(rt.back_qty, 0) AS back_qty
          FROM scm.mfg_sales_order_items i
          LEFT JOIN shipped s ON s.so_item_id = i.id
          LEFT JOIN returned rt ON rt.so_item_id = i.id
          JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
         WHERE h.company_id = ${CO} AND COALESCE(i.cancelled, false) = false
      )
      SELECT h.doc_no, h.status::text AS status, COUNT(*)::int AS lines,
             COUNT(*) FILTER (WHERE p.out_qty >= p.ordered AND p.ordered > 0)::int AS full_lines,
             COUNT(*) FILTER (WHERE p.back_qty > 0)::int AS returned_lines
        FROM per_line p
        JOIN scm.mfg_sales_orders h ON h.doc_no = p.doc_no
       WHERE h.company_id = ${CO}
         AND upper(COALESCE(h.status::text, '')) <> ALL(${SETTLED})
       GROUP BY 1, 2 ORDER BY 1`;

    const fully = rows.filter((r) => r.lines > 0 && r.full_lines === r.lines);
    log('');
    log(`COMPANY ${CO} — orders not settled: ${rows.length}; every line dispatched yet NOT delivered: ${fully.length}`);
    if (!fully.length) { log('   nothing to explain here.'); continue; }
    const byStatus = new Map();
    for (const r of fully) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    log(`   they sit in: ${[...byStatus].map(([s, n]) => `${s}: ${n}`).join(', ')}`);
    log(`   e.g. ${fully.slice(0, SHOW).map((r) => r.doc_no).join(', ')}`);
    const shortWithReturns = rows.filter((r) => r.full_lines !== r.lines && r.returned_lines > 0);
    log(`   (separately: ${shortWithReturns.length} order(s) are short BECAUSE goods came back —`
      + ' a return re-opens the quantity, so those are correctly not delivered)');

    /* THE ANSWER. The sync advances an SO when its DO changes status; a DO that
       never reached a delivered status never triggered it. */
    const docs = fully.map((r) => r.doc_no);
    const dos = await sql`
      SELECT dh.status::text AS st, COUNT(DISTINCT dh.id)::int AS n
        FROM scm.delivery_orders dh
       WHERE dh.company_id = ${CO} AND dh.so_doc_no = ANY(${docs})
       GROUP BY 1 ORDER BY 2 DESC`;
    log(`   their DELIVERY ORDERS sit at: `
      + (dos.length ? dos.map((d) => `${d.st} ${d.n}`).join(', ') : '(no DO carries so_doc_no — a different fault)'));
  }

  log('');
  log('NOTHING WAS WRITTEN.');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
