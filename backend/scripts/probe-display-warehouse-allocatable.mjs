#!/usr/bin/env node
// Can stock STANDING IN A SHOWROOM be sold off a customer order?
//
// THE QUESTION. The 2026-09-08 cutover brought the book's showroom display
// sofas into the ERP exactly as AutoCount holds them — no flag, no marking,
// because the owner refused one: 「你换不一样就代表我们的数据从 autocount 搬过
// 来的就不一样了啊」. Complete data, our rules ON TOP. So the rule has to be
// asked as its own question, of the RULE layer: today, can a unit that stands
// in a display warehouse be allocated to a customer order and make its line
// read READY?
//
// This probe does not answer from the sofas. The sofas are 26 units in two
// showrooms; the axis is EVERY non-selling warehouse and EVERY item group, and
// the answer has to be measured on that whole surface or it is not an answer.
//
// WHAT THE CODE ALREADY SAYS, so the probe knows what it is trying to refute:
//
//   - `so-stock-allocation.ts` step 6 reads `inventory_balances` with
//     `.select('warehouse_id, item_code, variant_key, qty').in('item_code', …)`
//     and NO warehouse predicate of any kind. It buckets on whatever
//     `warehouse_id` the SO LINE carries. There is no showroom exclusion in it,
//     in `sofa-set-coverage.ts`, or in `so-line-effective-stock.ts`.
//   - the ERP nevertheless ALREADY OWNS the axis: `inventory.ts` defines
//     `NON_SELLING_WAREHOUSE_TYPES = {showroom, display, service}` over
//     `warehouses.type`, and the owner already ruled on it once — for the
//     dead-stock badge, 「它明明是 showroom 的 display 啊」.
//
//   So the shape of the finding is: the concept exists, one screen reads it,
//   the allocator does not. That is a RULE-LAYER gap, and the fix is a rule
//   that reads `warehouses.type` — never a flag written onto a migrated row.
//
// THE TRAP THIS PROBE EXISTS TO CATCH. An axis that exists in code can still be
// EMPTY in the data. If `warehouses.type` is NULL for the showrooms, then a
// rule reading it would be a no-op and the recommendation would be wrong. So
// section 1 measures whether the column is actually populated, and every later
// count is reported against BOTH the typed set and a name-matched set, with the
// difference named. Never recommend a switch without proving it is wired to
// something.
//
// READ-ONLY: SELECTs only. No DDL, no writes, no transaction. Exit 0 for every
// legitimate answer — the answer IS the output; non-zero is reserved for an
// unreachable database.
//
// Run under tsx (it imports the ERP's own TS rule):
//   npx tsx scripts/probe-display-warehouse-allocatable.mjs
import postgres from 'postgres';
import { isHardBoundLine, HARD_BOUND_COMPANY_ID } from '../src/scm/lib/so-stock-allocation.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY ?? 1);
const SHOW = Number(process.env.SHOW ?? 15);
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/* The ERP's own set, copied from routes/inventory.ts and named as a copy. If
   that file's set ever changes, this comment is the pointer back. */
const NON_SELLING_WAREHOUSE_TYPES = new Set(['showroom', 'display', 'service']);
/* The name test is the FALLBACK axis, used only to measure how much the typed
   axis would miss. It is never the recommendation. */
const looksNonSelling = (code, name) => /\b(DISP|DISPLAY|SHOWROOM|SERVICE|SERV)\b/i.test(`${code ?? ''} ${name ?? ''}`);

async function main() {
  log(`=== CAN SHOWROOM STOCK BE SOLD? — company ${CO}, read-only ===`);

  /* 1. THE AXIS ITSELF. Does warehouses.type carry the value a rule would read? */
  const whs = await sql`
    SELECT id, code, name, type::text AS type,
           COALESCE(is_showroom, false) AS is_showroom,
           COALESCE(is_active, true) AS is_active
      FROM scm.warehouses
     WHERE company_id = ${CO}
     ORDER BY code`;
  log(`warehouses in company ${CO}: ${whs.length}`);

  const typed = whs.filter((w) => NON_SELLING_WAREHOUSE_TYPES.has(String(w.type ?? '').toLowerCase()));
  const named = whs.filter((w) => looksNonSelling(w.code, w.name));
  const typedIds = new Set(typed.map((w) => w.id));
  const namedIds = new Set(named.map((w) => w.id));
  const namedNotTyped = named.filter((w) => !typedIds.has(w.id));
  const typedNotNamed = typed.filter((w) => !namedIds.has(w.id));

  log(`non-selling by warehouses.type (${[...NON_SELLING_WAREHOUSE_TYPES].join('/')}): ${typed.length}`);
  log(`non-selling by NAME (fallback axis, for comparison only): ${named.length}`);
  if (typed.length === 0) {
    log('  !! warehouses.type carries NO non-selling value in this company — the axis exists in code and is EMPTY in the data.');
    log('     A rule reading warehouses.type would be a NO-OP. Populating type is then part of any fix.');
  }
  if (namedNotTyped.length) {
    log(`  !! ${namedNotTyped.length} warehouse(s) READ as non-selling by name but are NOT typed — a type-only rule would still allocate these:`);
    for (const w of namedNotTyped.slice(0, SHOW)) log(`     ${w.code} — "${w.name}" — type=${w.type ?? 'NULL'} is_showroom=${w.is_showroom}`);
  }
  if (typedNotNamed.length) {
    for (const w of typedNotNamed.slice(0, SHOW)) log(`  typed non-selling whose name does not say so: ${w.code} — "${w.name}" — type=${w.type}`);
  }
  log('non-selling warehouses, as the data holds them:');
  for (const w of (typed.length ? typed : named).slice(0, 40)) {
    log(`   ${w.code} — "${w.name}" — type=${w.type ?? 'NULL'} is_showroom=${w.is_showroom} active=${w.is_active}`);
  }

  /* The set this probe measures against: the UNION, so nothing that a human
     would call a showroom escapes the count just because it is untyped. */
  const probeIds = new Set([...typedIds, ...namedIds]);
  const byId = new Map(whs.map((w) => [w.id, w]));
  if (probeIds.size === 0) { log('no non-selling warehouse found by either axis — nothing further to measure.'); return; }

  /* 2. WHAT STANDS IN THEM. inventory_balances is the same view the allocator
        reads, so this is on-hand exactly as the allocator would see it. */
  const bal = await sql`
    SELECT b.warehouse_id, b.item_code, COALESCE(b.variant_key,'') AS variant_key,
           b.qty::numeric AS qty, p.category::text AS category
      FROM scm.inventory_balances b
      LEFT JOIN scm.mfg_products p ON p.code = b.item_code
     WHERE b.warehouse_id = ANY(${[...probeIds]}) AND b.qty <> 0`;
  const pooled = [], bound = [];
  for (const r of bal) (isHardBoundLine(r.category, r.item_code) ? bound : pooled).push(r);
  const units = (rows) => rows.reduce((a, r) => a + Number(r.qty), 0);
  log('');
  log(`=== STOCK STANDING IN NON-SELLING WAREHOUSES (${probeIds.size} warehouse(s)) ===`);
  log(`cells: ${bal.length} | units: ${units(bal)}`);
  log(`  HARD-BOUND groups (sofa / bedframe / (SP) mattress): ${bound.length} cells / ${units(bound)} units`);
  log(`  POOLED groups (mattress / accessory / others — these allocate on on-hand alone): ${pooled.length} cells / ${units(pooled)} units`);
  const perWh = new Map();
  for (const r of bal) {
    const k = r.warehouse_id;
    const e = perWh.get(k) ?? { cells: 0, units: 0, pooledUnits: 0 };
    e.cells++; e.units += Number(r.qty);
    if (!isHardBoundLine(r.category, r.item_code)) e.pooledUnits += Number(r.qty);
    perWh.set(k, e);
  }
  log('  per warehouse (units | of which POOLED = sellable the moment a line points here):');
  for (const [id, e] of [...perWh.entries()].sort((a, b) => b[1].units - a[1].units)) {
    const w = byId.get(id);
    log(`     ${w?.code ?? id} — ${e.cells} cells / ${e.units} units | pooled ${e.pooledUnits}`);
  }

  /* 2b. The 26 migrated display sofas specifically: they came in with NO
         batch_no, and sofa readiness runs through loadSofaBatchStock, which
         reads `.not('batch_no','is',null)`. Measure it rather than assert it. */
  /* v_inventory_lots_open is the EXACT view loadSofaBatchStock reads, so a lot
     counted here is a lot the allocator can see — measuring inventory_movements
     instead would answer a question the allocator never asks. */
  const sofaLots = await sql`
    SELECT l.warehouse_id, COUNT(*)::int AS lots,
           COUNT(*) FILTER (WHERE l.batch_no IS NULL)::int AS no_batch,
           COALESCE(SUM(l.qty_remaining) FILTER (WHERE l.batch_no IS NOT NULL AND l.qty_remaining > 0), 0)::numeric AS coverable_qty
      FROM scm.v_inventory_lots_open l
      JOIN scm.mfg_products p ON p.code = l.item_code
     WHERE l.warehouse_id = ANY(${[...probeIds]})
       AND lower(p.category::text) = 'sofa'
     GROUP BY l.warehouse_id`;
  log('');
  log('=== the migrated showroom SOFA lots — can sofa coverage even see them? ===');
  if (sofaLots.length === 0) log('  no open sofa lots in any non-selling warehouse.');
  for (const r of sofaLots) {
    const w = byId.get(r.warehouse_id);
    log(`   ${w?.code ?? r.warehouse_id}: ${r.lots} open lot(s), ${r.no_batch} with NO batch_no, ${r.coverable_qty} unit(s) VISIBLE to sofa coverage`);
  }
  log('  (a sofa line reaches READY only via sofa-set-coverage.findCoveringBatch, whose');
  log('   loadSofaBatchStock reads v_inventory_lots_open .not(batch_no,is,null) — a lot with');
  log('   no batch is invisible to it, so a batch-less showroom sofa can cover nothing)');

  /* 3. THE ACTUAL EXPOSURE TODAY. Does any live order line point at one? */
  const lines = await sql`
    SELECT i.doc_no, i.item_code, i.item_group::text AS item_group,
           i.warehouse_id, i.stock_status::text AS stock_status,
           i.qty::numeric AS qty, o.company_id, o.status::text AS so_status
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
     WHERE i.warehouse_id = ANY(${[...probeIds]})
       AND COALESCE(i.cancelled, false) = false`;
  log('');
  log('=== SALES-ORDER LINES POINTING AT A NON-SELLING WAREHOUSE (all companies) ===');
  log(`lines: ${lines.length}`);
  const byStatus = new Map();
  for (const l of lines) byStatus.set(l.stock_status, (byStatus.get(l.stock_status) ?? 0) + 1);
  for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) log(`   stock_status ${s}: ${n}`);
  const ready = lines.filter((l) => String(l.stock_status ?? '').toUpperCase().includes('READY'));
  log(`READY lines drawing showroom stock RIGHT NOW: ${ready.length}`);
  for (const l of ready.slice(0, SHOW)) {
    const w = byId.get(l.warehouse_id);
    log(`   ${l.doc_no} (co=${l.company_id}) ${l.item_code} x${l.qty} @ ${w?.code ?? l.warehouse_id} — ${l.stock_status}`);
  }

  /* 4. THE PROSPECTIVE ANSWER — the one that matters even when section 3 is
        zero. A POOLED line at a non-selling warehouse goes READY on on-hand
        alone. So: does that stock exist, and is the warehouse pickable? */
  const pickable = (typed.length ? typed : named).filter((w) => w.is_active);
  log('');
  log('=== WOULD A NEW ORDER LINE AT A SHOWROOM GO READY? ===');
  log(`non-selling warehouses that are is_active=true (so a user can pick them on a line): ${pickable.length} of ${(typed.length ? typed : named).length}`);
  log(`pooled units standing in them: ${units(pooled)}`);
  log(`the allocator applies NO warehouse-type predicate (so-stock-allocation.ts step 6 reads inventory_balances unfiltered),`);
  log(`so a POOLED line created at one of these warehouses allocates against that stock and reads READY.`);
  log(`Company ${HARD_BOUND_COMPANY_ID} hard-bound groups are the exception — they need their own received PO, which a display unit has not got.`);

  const topPooled = [...pooled].sort((a, b) => Number(b.qty) - Number(a.qty)).slice(0, SHOW);
  if (topPooled.length) {
    log('the pooled stock most exposed (biggest cells):');
    for (const r of topPooled) {
      const w = byId.get(r.warehouse_id);
      log(`   ${r.item_code} x${r.qty} @ ${w?.code ?? r.warehouse_id} [${r.category ?? 'uncategorised'}]`);
    }
  }
}

main().then(() => sql.end()).catch((e) => { console.error(e); sql.end(); process.exit(1); });
