#!/usr/bin/env node
/* HC-0110 follow-up: open the stock for the HC-PO-008783 Maybatch sofa
 * (HC-SO-011733, CH141-08, customer date 2026-10-30) so its delivery order can
 * be raised.
 *
 * WHY IT HAS NO STOCK. AutoCount received the set on GR-004863 (2026-06-16) as
 * one collapsed line. import-ac-sofa-stock.mjs opened every on-hand sofa from
 * its received PO lines on 2026-08-10, but this build was still the undecoded
 * placeholder then, and its AutoCount item code does not resolve, so the
 * import reads AutoCount's balance as 0 and drops it - still dropped on the
 * 2026-10-15 dry run (run 38701788324: "DROP placeholder" and "DROP
 * over-balance ... AutoCount holds 0"). repair-hc0110-sofa-piece-receipts.mjs
 * then made every piece read received, so the lines are READY by hard binding,
 * but no lot means no allocated_batch_no, and the sofa batch guard
 * (src/scm/lib/sofa-batch-guard.ts) refuses any DO for the set.
 *
 * THE WRITE. One positive ADJUSTMENT movement per SO sofa line - the FIFO
 * trigger opens the lot - at the line's own warehouse, with:
 *   batch_no    = HC-PO-008783 (the batch identity import-ac-sofa-stock uses:
 *                 the PO number, one dye lot);
 *   variant_key = computeVariantKey of the SO line itself, so the allocator's
 *                 findCoveringBatch matches it by construction;
 *   created_at  = the GRN's received date, so FIFO ages it correctly;
 *   cost        = the lead receipt line's unit price on the lead piece, 0 on
 *                 the rest (the import's convention; the set total is exact).
 *
 * PRECONDITION OUTSIDE THE DATABASE: Sim / the KL warehouse confirmed the
 * whole set is physically there. Do not apply before that.
 *
 * GATES: the SO's live sofa lines are exactly EXPECTED; one warehouse; every
 * line READY with its PO piece received in full; no open lot and no movement
 * already carries this batch for these codes; nothing has shipped.
 *
 * MODE=plan (default) writes the movements inside a transaction, reads the
 * lots the trigger opened, checks they cover the set, and ROLLS BACK. MODE=apply
 * with CONFIRM="I HAVE REVIEWED THE DRY-RUN" commits and re-reads on a FRESH
 * connection. Afterwards run "Recompute SO stock allocation" for HC-SO-011733.
 *
 * RE-RUN: inert. A second run finds the lots this one opened and refuses.
 */
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { multiset } from './lib/redecode-sofa-plan.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

const CO = 1;
const SO = 'HC-SO-011733';
const PO = 'HC-PO-008783';
const GRN = 'HC-GR-004863';
const BATCH = PO;
const TAG = 'HC-0110-PO-008783';
const LEAD = '9058-2A(LHF)';
const EXPECTED = ['9058-2A(LHF)', '9058-CNR', '9058-1NA', '9058-1NA', '9058-CONSOLE', '9058-1A(RHF)'];
const ROLLBACK = Symbol('plan rollback');

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const fail = async (m) => { bad(`REFUSED ${m}`); await sql.end({ timeout: 5 }); process.exit(1); };

async function main() {
  log(`HC-0110 open sofa lot ${BATCH} for ${SO} - mode=${APPLY ? 'APPLY' : 'PLAN (rehearsed in a transaction, rolled back)'}`);

  const lines = await sql`
    SELECT s.id::text AS id, s.item_code, s.item_group, s.description, s.qty::float8 AS qty,
           s.warehouse_id::text AS wh, s.stock_status, s.allocated_batch_no, s.variants,
           (SELECT COALESCE(SUM(p.received_qty),0)::float8 FROM scm.purchase_order_items p
             JOIN scm.purchase_orders h ON h.id = p.purchase_order_id
            WHERE p.so_item_id = s.id AND h.po_number = ${PO}) AS po_received,
           (SELECT COUNT(*)::int FROM scm.delivery_order_items d WHERE d.so_item_id = s.id) AS do_lines
      FROM scm.mfg_sales_order_items s
     WHERE s.doc_no = ${SO} AND s.company_id = ${CO} AND s.cancelled = false
       AND lower(s.item_group) = 'sofa'`;
  if (multiset(lines.map((l) => l.item_code)) !== multiset(EXPECTED)) {
    return fail(`${SO} sofa lines are [${multiset(lines.map((l) => l.item_code))}], expected [${multiset(EXPECTED)}]`);
  }
  const whs = [...new Set(lines.map((l) => l.wh))];
  if (whs.length !== 1 || !whs[0]) return fail(`${SO} sofa lines sit in ${whs.length} warehouse(s): ${whs.join(', ')}`);
  const wh = whs[0];
  const [whRow] = await sql`SELECT code, name FROM scm.warehouses WHERE id = ${wh}::uuid`;
  for (const l of lines) {
    if (l.po_received < l.qty) return fail(`${l.item_code} reads received ${l.po_received} of ${l.qty} on ${PO} - run repair-hc0110-sofa-piece-receipts first`);
    if (l.do_lines > 0) return fail(`${l.item_code} is already on a delivery order`);
    if (l.allocated_batch_no) return fail(`${l.item_code} is already bound to batch ${l.allocated_batch_no}`);
  }

  const [{ n: lotsAlready }] = await sql`
    SELECT COUNT(*)::int n FROM scm.inventory_lots
     WHERE batch_no = ${BATCH} AND item_code = ANY(${[...new Set(EXPECTED)]}) AND qty_remaining > 0`;
  if (lotsAlready) return fail(`${lotsAlready} open lot(s) already carry batch ${BATCH} - nothing to open`);
  const [{ n: mvAlready }] = await sql`SELECT COUNT(*)::int n FROM scm.inventory_movements WHERE source_doc_no = ${TAG}`;
  if (mvAlready) return fail(`${mvAlready} movement(s) already carry ${TAG}`);

  const [grn] = await sql`
    SELECT g.received_at::text AS received_at, gi.unit_price_sen::bigint AS lead_cost
      FROM scm.grns g JOIN scm.grn_items gi ON gi.grn_id = g.id
      JOIN scm.purchase_order_items p ON p.id = gi.purchase_order_item_id
     WHERE g.grn_number = ${GRN} AND p.item_code = ${LEAD} AND g.status::text = 'POSTED'`;
  if (!grn) return fail(`${GRN} has no posted ${LEAD} line`);
  const receivedAt = `${String(grn.received_at).slice(0, 10)}T00:00:00Z`;

  const mvCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='scm' AND table_name='inventory_movements'`).map((r) => r.column_name);
  let leadPriced = false;
  const plan = lines.map((l) => {
    const isLead = l.item_code === LEAD && !leadPriced;
    if (isLead) leadPriced = true;
    return {
      soItemId: l.id, code: l.item_code, name: l.description ?? l.item_code, qty: l.qty,
      variantKey: computeVariantKey(l.item_group, l.variants), cost: isLead ? Number(grn.lead_cost) : 0,
    };
  });

  log(`warehouse ${whRow?.code ?? wh} (${whRow?.name ?? '?'}), batch ${BATCH}, received_at ${receivedAt}`);
  for (const p of plan) log(`   +${p.qty} ${p.code.padEnd(14)} cost ${(p.cost / 100).toFixed(2)}  [${p.variantKey}]`);

  let opened = null;
  try {
    opened = await sql.begin(async (tx) => {
      for (const p of plan) {
        const cols = ['movement_type', 'warehouse_id', 'item_code', 'product_name', 'variant_key',
          'qty', 'unit_cost_sen', 'batch_no', 'source_doc_type', 'source_doc_no', 'notes', 'created_at'];
        const args = ['ADJUSTMENT', wh, p.code, p.name, p.variantKey, p.qty, p.cost, BATCH,
          'AC_CUTOVER', TAG, `HC-0110: ${PO} set received on ${GRN} (AutoCount GR-004863) but never opened by the sofa import; opened for ${SO}`, receivedAt];
        if (mvCols.includes('company_id')) { cols.push('company_id'); args.push(CO); }
        await tx.unsafe(
          `INSERT INTO scm.inventory_movements (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
          args);
      }
      const lots = await tx`
        SELECT item_code, variant_key, qty_remaining::float8 AS q, warehouse_id::text AS wh
          FROM scm.inventory_lots WHERE batch_no = ${BATCH} AND qty_remaining > 0`;
      /* The allocator's own test: one batch holds every (code, variant) the set needs. */
      const have = new Map();
      for (const l of lots) if (l.wh === wh) have.set(`${l.item_code}|${l.variant_key ?? ''}`, (have.get(`${l.item_code}|${l.variant_key ?? ''}`) ?? 0) + l.q);
      const need = new Map();
      for (const p of plan) need.set(`${p.code}|${p.variantKey}`, (need.get(`${p.code}|${p.variantKey}`) ?? 0) + p.qty);
      const short = [...need].filter(([k, q]) => (have.get(k) ?? 0) < q);
      if (short.length) throw new Error(`the trigger's lots do not cover the set: ${short.map(([k]) => k).join(', ')}`);
      log(`  lots opened in the transaction: ${lots.length}; batch ${BATCH} covers all ${plan.length} lines of the set`);
      if (!APPLY) throw ROLLBACK;
      return lots.length;
    });
  } catch (e) {
    if (e === ROLLBACK) {
      await sql.end({ timeout: 5 });
      log('');
      log(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" once the set is confirmed in ${whRow?.code ?? 'the warehouse'}.`);
      return;
    }
    bad(`ROLLED BACK - ${e.message}`);
    await sql.end({ timeout: 5 });
    process.exit(1);
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    const lots = await check`
      SELECT item_code, qty_remaining::float8 AS q FROM scm.inventory_lots
       WHERE batch_no = ${BATCH} AND warehouse_id = ${wh}::uuid AND qty_remaining > 0`;
    const got = multiset(lots.flatMap((l) => Array(Math.round(l.q)).fill(l.item_code)));
    const ok = got === multiset(EXPECTED);
    (ok ? log : bad)(`VERIFIED ON A FRESH CONNECTION: ${opened} lot(s); pieces ${got} ${ok ? '==' : '!='} ${multiset(EXPECTED)}`);
    log(`Next, NOT run by this script: Recompute SO stock allocation for ${SO} (binds the batch).`);
    if (!ok) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.stack || e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
