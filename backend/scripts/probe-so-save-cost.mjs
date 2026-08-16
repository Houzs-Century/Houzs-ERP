#!/usr/bin/env node
/* What one SO save actually costs, measured against the live tree. READ-ONLY.
   No DDL, no writes, no transaction — every statement below is a SELECT.

   WHY. Saving an edited sales order and creating a new one both make the
   operator wait. Every SO write path except the header PATCH ends in an AWAITED
   `recomputeSoStockAllocation(sb)` — a GLOBAL sweep that walks every live SO and
   every one of its lines through PostgREST's 1000-row pages and `chunkIn`'s
   200-id batches. Its cost is a pure function of a handful of row counts, and
   those counts grow with the business. PR #1982 measured it at ~10s of a 10.65s
   header save on 2026-08-10 and deferred it for THAT one route only; the create
   route and the three line routes still wait for it.

   This prints the counts the sweep's own chunking reads, so the number of SERIAL
   PostgREST round trips one sweep makes is derived from TODAY's tree rather than
   from a comment. It also times each read, so the DB-side cost is visible
   separately from the per-request HTTP cost that dominates it.

   The round-trip arithmetic mirrors backend/src/scm/lib/paginate-all.ts:
     paginateAll -> floor(rows / 1000) + 1 requests
     chunkIn     -> one paginateAll per 200 ids
   If those constants move, this script's arithmetic is wrong; the constants are
   named below so the drift is visible rather than silent.

   Company is deliberately NOT a filter: the sweep is cross-company by design
   (so-stock-allocation.ts says so in its own header), so a per-company count
   would understate it.

   RE-RUN: idempotent — it is a read. Running it twice changes nothing.

   node scripts/probe-so-save-cost.mjs */
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* Byte-identical to backend/src/scm/shared/so-terminal-states.ts. Inlined as a
   SQL literal rather than bound: the values are compile-time constants here, and
   a bound text[] is exactly the parameter-inference shape that has produced
   42883 on this database before. */
const TERMINAL = ['CANCELLED', 'CLOSED', 'SHIPPED', 'DELIVERED', 'INVOICED', 'DRAFT'];
const TERM = TERMINAL.map((s) => `'${s}'`).join(',');
const LIVE_SO = `s.status NOT IN (${TERM})`;
const LIVE_LINE_IDS = `
  SELECT i.id FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
   WHERE ${LIVE_SO} AND i.cancelled = false`;

const PAGE = 1000;   // paginate-all.ts PAGE
const CHUNK = 200;   // paginate-all.ts chunkIn default `size`

const pagesFor = (rows) => Math.floor(rows / PAGE) + 1;
const chunksFor = (ids) => Math.max(1, Math.ceil(ids / CHUNK));

/* Printed as each one lands, not collected and printed at the end: the first
   run of this probe died on step 4 (an enum column) and threw away the three
   counts it had already got right. A number that has been measured must reach
   the log before the next statement can fail. */
async function count(label, query) {
  const t0 = Date.now();
  const rows = await sql.unsafe(query);
  const out = { label, ms: Date.now() - t0, n: Number(rows[0].n) };
  note(`  ${String(out.n).padStart(7)}  ${out.label}   [${out.ms} ms]`);
  return out;
}

async function main() {
  note(`=== SO save cost drivers — ${new Date().toISOString()} (read-only) ===\n`);

  const steps = [];
  note('--- row counts (each measured as ONE set-based query) ---');
  steps.push(await count('live SOs — sweep step 1',
    `SELECT count(*)::int AS n FROM scm.mfg_sales_orders s WHERE ${LIVE_SO}`));
  steps.push(await count('non-cancelled lines on them — step 2',
    `SELECT count(*)::int AS n FROM (${LIVE_LINE_IDS}) t`));
  steps.push(await count('mfg_products rows — step 2b (deliberately unscoped)',
    'SELECT count(*)::int AS n FROM scm.mfg_products'));
  steps.push(await count('sofa lines — step 2c allocated_batch_no read', `
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
     WHERE ${LIVE_SO} AND i.cancelled = false
       AND (upper(coalesce(i.item_group,'')) LIKE '%SOFA%'
            OR i.item_code IN (SELECT code FROM scm.mfg_products
                                WHERE upper(coalesce(category::text,'')) = 'SOFA'))`));
  steps.push(await count('bedframe + sofa lines — step 6b bound-PO read', `
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
     WHERE ${LIVE_SO} AND i.cancelled = false
       AND lower(coalesce(i.item_group,'')) IN ('bedframe','sofa')`));
  steps.push(await count('distinct product codes on live lines — step 6', `
    SELECT count(DISTINCT i.item_code)::int AS n
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no
     WHERE ${LIVE_SO} AND i.cancelled = false`));
  steps.push(await count('DO lines against those SO lines — step 3',
    `SELECT count(*)::int AS n FROM scm.delivery_order_items d
      WHERE d.so_item_id IN (${LIVE_LINE_IDS})`));
  steps.push(await count('distinct DOs behind them — step 3b',
    `SELECT count(DISTINCT d.delivery_order_id)::int AS n FROM scm.delivery_order_items d
      WHERE d.so_item_id IN (${LIVE_LINE_IDS})`));

  const [orders, lines, products, sofaLines, boundLines, codes, doItems, dos] = steps;
  const dbMs = steps.reduce((a, s) => a + s.ms, 0);

  note(`\n  the same information, asked as 8 set-based SQL queries, costs ${dbMs} ms of`);
  note('  database time in total. The database is not the problem.');

  /* The sweep does not issue set-based queries. It issues paginated / chunked
     PostgREST requests — one HTTPS round trip each, in series. */
  const linesPerDocChunk = Math.ceil(lines.n / chunksFor(orders.n));
  const rt = {
    'lock claim + release': 2,
    'mfg_sales_orders (paginateAll)': pagesFor(orders.n),
    'mfg_sales_order_items by doc_no (chunkIn 200 docs, each paginated)':
      chunksFor(orders.n) * pagesFor(linesPerDocChunk),
    'mfg_products (paginateAll)': pagesFor(products.n),
    'mfg_sales_order_items allocated_batch_no (chunkIn sofa line ids)': chunksFor(sofaLines.n),
    'delivery_order_items (chunkIn EVERY live line id)': chunksFor(lines.n),
    'delivery_orders (chunkIn DO ids)': chunksFor(dos.n),
    'inventory_balances (chunkIn product codes)': chunksFor(codes.n),
    'purchase_order_items (chunkIn bedframe/sofa line ids)': chunksFor(boundLines.n),
    'v_inventory_lots_open (single call, NOT paginated)': 1,
  };
  const total = Object.values(rt).reduce((a, b) => a + b, 0);

  note('\n--- SERIAL Worker->PostgREST round trips in ONE global sweep ---');
  for (const [k, v] of Object.entries(rt).sort((a, b) => b[1] - a[1])) {
    note(`  ${String(v).padStart(4)}  ${k}`);
  }
  note(`  ${String(total).padStart(4)}  TOTAL read round trips`);
  note('        (flip UPDATEs, the audit insert and header transitions are on top');
  note('         of this and vary with how much stock moved since the last sweep)');
  note(`\n  PR #1982 measured 10.0 s of sweep on prod 2026-08-10. Over ${total} round`);
  note(`  trips that is ${Math.round(10000 / total)} ms per round trip — the figure to sanity-check any`);
  note('  future claim against.');

  /* How often anyone pays it — so the per-save seconds can be turned into
     operator-hours rather than left as an anecdote. */
  note('\n--- how often a sweep is paid for (last 14 days, human actions only) ---');
  try {
    const freq = await sql.unsafe(`
      SELECT action::text AS action, count(*)::int AS n
        FROM scm.mfg_so_audit_log
       WHERE created_at >= now() - interval '14 days'
         AND action::text IN ('CREATE','ADD_LINE','UPDATE_LINE','DELETE_LINE')
         AND coalesce(source::text,'') <> 'auto-allocation'
       GROUP BY 1 ORDER BY n DESC`);
    let humanWrites = 0;
    for (const r of freq) { humanWrites += Number(r.n); note(`  ${String(r.n).padStart(6)}  ${r.action}`); }
    note(`  ${String(humanWrites).padStart(6)}  TOTAL  (~${(humanWrites / 14).toFixed(0)}/day)`);
  } catch (e) {
    /* Sizing colour, not the finding. Say the shape is unknown rather than let
       it delete the numbers above. */
    note(`  (unavailable: ${e instanceof Error ? e.message : String(e)})`);
  }

  note('\n--- who waits for that sweep today (mfg-sales-orders.ts on main) ---');
  note('  POST /                          awaits it before returning 201  (SO create)');
  note('  POST /:docNo/items              awaits it');
  note('  PATCH /:docNo/items/:itemId     awaits it');
  note('  DELETE /:docNo/items/:itemId    awaits it');
  note('  PATCH /:docNo (header)          DEFERRED since PR #1982 — the only one');

  await sql.end({ timeout: 5 });
}

main().catch(async (e) => { console.error(e); try { await sql.end({ timeout: 5 }); } catch { /* closed */ } process.exit(1); });
