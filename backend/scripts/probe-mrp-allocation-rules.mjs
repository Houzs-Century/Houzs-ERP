#!/usr/bin/env node
// ----------------------------------------------------------------------------
// READ-ONLY. The owner, 2026-09-07:
//   「1. 我的 BedFrame 跟 Sofa 是不是根据 PO Hard Binding 显示东西 Ready
//     2. 我的 Mattress 是不是跟着 Delivered 来分配 MRP
//     这样子看一下我的 MRP 是不是准确的」
//
// He is not asking what the rules ARE. He is asking whether the migrated book
// OBEYS them. So this probe hunts the REFUTATION of each rule and prints its
// count, not a reassuring summary of the rule.
//
//   RULE 1 (hard binding). A company-1 BEDFRAME / SOFA / "(SP)" MATTRESS line
//     lights READY only through its OWN received purchase order
//     (`isHardBoundLine`, so-stock-allocation.ts). The pooled walk must never
//     be its evidence.
//     REFUTED BY: a hard-bound line reading READY (or PARTIAL with qty) that
//     has NO purchase_order_items row of its own with received_qty > 0.
//     A SOFA line may also light through a covering dye lot
//     (`allocated_batch_no`, step 7b) — that is a SECOND path, so it is counted
//     SEPARATELY rather than folded into either verdict.
//
//   RULE 2 (pooled). An ordinary MATTRESS (no "(SP)") allocates from the pooled
//     warehouse balance — stock that was received into the warehouse.
//     REFUTED BY: a mattress line reading READY whose own
//     (warehouse, item_code, variant_key) bucket holds NO stock at all.
//
// NO LOGIC IS RE-IMPLEMENTED HERE. `isHardBoundLine`, `computeVariantKey`,
// `isServiceLine`, `normCategory`, `doCountsAsDelivered` and
// `HARD_BOUND_COMPANY_ID` are IMPORTED from the modules the running ERP uses
// (hence tsx). A second copy of the predicate would make this probe measure
// itself instead of the ERP — CLAUDE.md's "a check that answers a different
// question".
//
// PRIVACY: this repository and its Actions logs are PUBLIC. Counts, statuses,
// item groups and document numbers only — no prices, no customers.
//
// NOTHING IS WRITTEN. SELECTs only, no DDL, no transaction.
//
//   DATABASE_URL  required
//   COMPANY       company id (default 1 — the hard-bound company)
//   SHOW          how many document numbers to name per class (default 12)
//
// RE-RUN: idempotent and side-effect free.
// Run under tsx (TS imports): npx tsx scripts/probe-mrp-allocation-rules.mjs
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from '../src/scm/lib/so-stock-allocation';
import { normCategory } from '../src/scm/lib/so-readiness';
import { computeVariantKey, isServiceLine } from '../src/scm/shared';
import { doCountsAsDelivered } from '../src/scm/shared/do-shipped-states';
import { SO_TERMINAL_STATES } from './lib/so-terminal-states.mjs';

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : m);

function fromDevVars(field) {
  try {
    return readFileSync('.dev.vars', 'utf8').match(new RegExp(`^${field}="?([^"\\n]+)"?`, 'm'))?.[1];
  } catch { return undefined; }
}
const DATABASE_URL = process.env.DATABASE_URL || fromDevVars('DATABASE_URL');
if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(2); }
const CO = Number(process.env.COMPANY || HARD_BOUND_COMPANY_ID);
const SHOW = Number(process.env.SHOW || 12);
const WH_NONE = 'NOWH';

const sql = postgres(DATABASE_URL, { ssl: 'require', prepare: false, max: 1 });
const names = (arr) => [...new Set(arr.map((r) => r.doc_no))].slice(0, SHOW).join(', ')
  + (new Set(arr.map((r) => r.doc_no)).size > SHOW ? ` (+${new Set(arr.map((r) => r.doc_no)).size - SHOW} more orders)` : '');
const docs = (arr) => [...new Set(arr.map((r) => r.doc_no))];

async function main() {
  log(`company ${CO}${CO === HARD_BOUND_COMPANY_ID ? ' (the hard-bound company)' : ' (NOT the hard-bound company - rule 1 does not apply here)'}`);

  // 1. Live orders (the allocator's own lens) + the processing-date gate.
  const orders = await sql`
    SELECT doc_no, status::text AS status, processing_date
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}
       AND upper(COALESCE(status::text, '')) <> ALL(${SO_TERMINAL_STATES})
     ORDER BY doc_no`;
  const gated = new Set(orders.filter((o) => !o.processing_date).map((o) => o.doc_no));
  log(`live sales orders: ${orders.length}; of them WITHOUT a Processing Date (the allocator refuses to allocate to these): ${gated.size}`);
  if (orders.length === 0) { log('nothing to check.'); return; }
  const docNos = orders.map((o) => o.doc_no);

  // 2. Their live lines.
  const lines = await sql`
    SELECT id, doc_no, item_code, item_group, variants, qty::numeric AS qty,
           warehouse_id, stock_status::text AS stock_status,
           COALESCE(stock_qty_ready, 0)::numeric AS qty_ready, allocated_batch_no
      FROM scm.mfg_sales_order_items
     WHERE doc_no = ANY(${docNos}) AND COALESCE(cancelled, false) = false`;
  log(`live, non-cancelled order lines: ${lines.length}`);

  // 3. Already delivered / returned per line - the allocator's own predicate
  //    decides which delivery orders count (do-shipped-states.ts).
  const doRows = await sql`
    SELECT di.so_item_id, di.id AS do_item_id, di.qty::numeric AS qty,
           dh.status::text AS do_status
      FROM scm.delivery_order_items di
      JOIN scm.delivery_orders dh ON dh.id = di.delivery_order_id
     WHERE di.so_item_id IS NOT NULL`;
  const delivered = new Map(); const liveDoItems = new Set();
  for (const r of doRows) {
    if (!doCountsAsDelivered(r.do_status)) continue;
    liveDoItems.add(r.do_item_id);
    delivered.set(r.so_item_id, (delivered.get(r.so_item_id) ?? 0) + Number(r.qty));
  }
  const drRows = await sql`
    SELECT dri.do_item_id, dri.qty_returned::numeric AS qty, dr.status::text AS st
      FROM scm.delivery_return_items dri
      JOIN scm.delivery_returns dr ON dr.id = dri.delivery_return_id`;
  const doItemToSo = new Map(doRows.map((r) => [r.do_item_id, r.so_item_id]));
  const returned = new Map();
  for (const r of drRows) {
    if (String(r.st ?? '').toUpperCase() === 'CANCELLED') continue;
    if (!liveDoItems.has(r.do_item_id)) continue;
    const soItem = doItemToSo.get(r.do_item_id);
    if (!soItem) continue;
    returned.set(soItem, (returned.get(soItem) ?? 0) + Number(r.qty));
  }

  // 4. Each line's OWN received purchase order - the hard-binding evidence.
  //    Exactly what the allocator reads: purchase_order_items.so_item_id with
  //    received_qty > 0, no filter on the PO header (the cancelled tally below
  //    is printed separately rather than applied, so this stays a mirror).
  const lineIds = lines.map((l) => l.id);
  const poRows = await sql`
    SELECT poi.so_item_id, SUM(COALESCE(poi.received_qty, 0))::numeric AS got,
           COUNT(*) FILTER (WHERE upper(COALESCE(ph.status::text, '')) = 'CANCELLED')::int AS cancelled_pos
      FROM scm.purchase_order_items poi
      LEFT JOIN scm.purchase_orders ph ON ph.id = poi.purchase_order_id
     WHERE poi.so_item_id = ANY(${lineIds}) AND COALESCE(poi.received_qty, 0) > 0
     GROUP BY 1`;
  const ownPo = new Map(poRows.map((r) => [r.so_item_id, Number(r.got)]));
  const ownPoCancelled = new Map(poRows.map((r) => [r.so_item_id, Number(r.cancelled_pos)]));

  // 5. Pooled on-hand, keyed exactly as the allocator keys it.
  const itemCodes = [...new Set(lines.map((l) => l.item_code).filter(Boolean))];
  const bal = await sql`
    SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS variant_key, SUM(qty)::numeric AS qty
      FROM scm.inventory_balances WHERE item_code = ANY(${itemCodes})
     GROUP BY 1, 2, 3`;
  const onHand = new Map(); const onHandBySku = new Map();
  for (const r of bal) {
    onHand.set(`${r.warehouse_id}::${r.item_code}::${r.variant_key}`, Number(r.qty));
    onHandBySku.set(r.item_code, (onHandBySku.get(r.item_code) ?? 0) + Number(r.qty));
  }

  // -- classify every line the way the allocator would ------------------------
  const bound = []; const mattress = []; const spMattress = [];
  let skippedService = 0; let skippedShipped = 0;
  for (const l of lines) {
    if (isServiceLine({ itemGroup: l.item_group, itemCode: l.item_code, category: null })) { skippedService += 1; continue; }
    const remaining = Number(l.qty) - (delivered.get(l.id) ?? 0) + (returned.get(l.id) ?? 0);
    if (remaining <= 0) { skippedShipped += 1; continue; }
    const rec = {
      ...l,
      remaining,
      got: ownPo.get(l.id) ?? 0,
      bucket: `${l.warehouse_id ?? WH_NONE}::${l.item_code}::${computeVariantKey(l.item_group, l.variants)}`,
      hardBound: isHardBoundLine(l.item_group, l.item_code),
      cat: normCategory(l.item_group),
    };
    rec.pool = onHand.get(rec.bucket) ?? 0;
    if (rec.hardBound) { bound.push(rec); if (rec.cat === 'MATTRESS') spMattress.push(rec); }
    else if (rec.cat === 'MATTRESS') mattress.push(rec);
  }
  log(`lines set aside: ${skippedService} SERVICE (carry no stock), ${skippedShipped} already fully delivered`);
  log('');

  // -- RULE 1 -----------------------------------------------------------------
  const READY = (r) => r.stock_status === 'READY';
  const CLAIMS = (r) => r.stock_status === 'READY' || (r.stock_status === 'PARTIAL' && Number(r.qty_ready) > 0);
  log('RULE 1 - BEDFRAME / SOFA / "(SP)" MATTRESS must light ONLY through their own received PO');
  log(`  hard-bound lines still to deliver: ${bound.length} on ${docs(bound).length} orders`);
  const byCat = new Map();
  for (const r of bound) byCat.set(r.cat, (byCat.get(r.cat) ?? 0) + 1);
  log(`    by category: ${[...byCat].map(([k, n]) => `${k}: ${n}`).join(', ')}`);
  const boundReady = bound.filter(CLAIMS);
  log(`  of them showing READY or PARTIAL-with-qty: ${boundReady.length} on ${docs(boundReady).length} orders`);
  const okOwnPo = boundReady.filter((r) => r.got >= r.remaining);
  const shortOwnPo = boundReady.filter((r) => r.got > 0 && r.got < r.remaining);
  const noPoButBatch = boundReady.filter((r) => r.got <= 0 && r.allocated_batch_no);
  const REFUTE1 = boundReady.filter((r) => r.got <= 0 && !r.allocated_batch_no);
  log(`    [a] own PO received in full            : ${okOwnPo.length}`);
  log(`    [b] own PO received but SHORT of need  : ${shortOwnPo.length}`);
  log(`    [c] no own PO, lit by a covering dye lot (SOFA batch path): ${noPoButBatch.length}`);
  log(`    [d] REFUTATION - no own received PO and no dye lot: ${REFUTE1.length}`);
  if (REFUTE1.length) {
    warn(`  RULE 1 IS REFUTED on ${REFUTE1.length} line(s) / ${docs(REFUTE1).length} order(s)`);
    const g = new Map();
    for (const r of REFUTE1) g.set(`${r.cat}/${r.stock_status}`, (g.get(`${r.cat}/${r.stock_status}`) ?? 0) + 1);
    log(`      by group/status: ${[...g].map(([k, n]) => `${k}: ${n}`).join(', ')}`);
    const alsoGated = REFUTE1.filter((r) => gated.has(r.doc_no));
    log(`      of those, ${alsoGated.length} sit on an order with NO Processing Date (the allocator forces those PENDING, so READY there is doubly wrong)`);
    const withPool = REFUTE1.filter((r) => r.pool > 0);
    log(`      of those, ${withPool.length} DO have pooled stock in their own bucket - i.e. they look pooled-fed, which is exactly what hard binding forbids`);
    log(`      orders: ${names(REFUTE1)}`);
  } else {
    log('  PROVEN ZERO: every hard-bound line that shows ready traces to its own received PO or a covering dye lot.');
  }
  if (noPoButBatch.length) log(`      dye-lot orders: ${names(noPoButBatch)}`);
  const cancelledPoBacked = boundReady.filter((r) => (ownPoCancelled.get(r.id) ?? 0) > 0);
  log(`  (separately: ${cancelledPoBacked.length} ready hard-bound line(s) are backed by a receipt on a CANCELLED purchase order - the allocator does not filter the PO header)`);
  log('');

  // -- RULE 2 -----------------------------------------------------------------
  log('RULE 2 - ordinary MATTRESS allocates from the pooled warehouse balance');
  log(`  ordinary (non-"(SP)") mattress lines still to deliver: ${mattress.length} on ${docs(mattress).length} orders`);
  const mReady = mattress.filter(READY);
  const backed = mReady.filter((r) => r.pool > 0);
  const REFUTE2 = mReady.filter((r) => r.pool <= 0);
  log(`  of them READY: ${mReady.length}`);
  log(`    [a] their own (warehouse, item, variant) bucket holds stock: ${backed.length}`);
  log(`    [b] REFUTATION - READY with NOTHING in that bucket: ${REFUTE2.length}`);
  if (REFUTE2.length) {
    warn(`  RULE 2 IS REFUTED on ${REFUTE2.length} line(s) / ${docs(REFUTE2).length} order(s)`);
    const noWh = REFUTE2.filter((r) => !r.warehouse_id).length;
    const skuElsewhere = REFUTE2.filter((r) => (onHandBySku.get(r.item_code) ?? 0) > 0).length;
    log(`      ${noWh} carry no warehouse at all; ${skuElsewhere} have stock of that SKU under a DIFFERENT warehouse or variant`);
    log(`      orders: ${names(REFUTE2)}`);
  } else {
    log('  PROVEN ZERO: every ready ordinary mattress is standing in its own warehouse bucket.');
  }
  const demand = new Map();
  for (const r of mReady) demand.set(r.bucket, (demand.get(r.bucket) ?? 0) + r.remaining);
  const over = [...demand].filter(([b, d]) => d > (onHand.get(b) ?? 0));
  log(`  buckets where the READY mattress demand exceeds the on-hand qty: ${over.length} of ${demand.size}`);

  const spReady = spMattress.filter(CLAIMS);
  const REFUTE2B = spReady.filter((r) => r.got <= 0);
  log(`  "(SP)" special-order mattress lines showing ready: ${spReady.length}; of them fed by NO own received PO (must be 0): ${REFUTE2B.length}`);
  if (REFUTE2B.length) { warn(`  (SP) mattress hard binding REFUTED on ${REFUTE2B.length} line(s)`); log(`      orders: ${names(REFUTE2B)}`); }
  log('');

  // -- the display layer, where the owner actually reads it -------------------
  //  effectiveLineStockStatus promotes a stored-PENDING line to READY when live
  //  MRP sees stock - but NOT for a hard-bound line and NOT on an un-processed
  //  order. So for rule 1 the stored verdict IS what he sees. For a mattress it
  //  is not: this counts the lines the promotion arm can still light up.
  const promotable = mattress.filter((r) => !READY(r) && !gated.has(r.doc_no) && (onHandBySku.get(r.item_code) ?? 0) > 0);
  log('DISPLAY - hard-bound lines cannot be promoted by the live-MRP union (so-line-effective-stock.ts gates them), so what is stored above is what the screen shows.');
  log(`  ordinary mattress lines stored PENDING that the live-MRP union may still show as Ready (SKU has stock somewhere): ${promotable.length}`);
  log('');
  log('NOTHING WAS WRITTEN.');
}

main().then(() => sql.end()).catch(async (e) => { console.error(e); await sql.end(); process.exit(2); });
