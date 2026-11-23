#!/usr/bin/env node
/* Give each AutoCount opening-stock movement the specification its own lot already carries.

   WHAT WENT WRONG. On 9 Sep 2026 fill-cutover-lot-variants-2026-09-09.mjs gave the cutover's bedframe and sofa
   LOTS (scm.inventory_lots.variant_key) their specification. The MOVEMENTS that created those lots
   (scm.inventory_movements, source_doc_type AC_CUTOVER, ADJUSTMENT) kept a blank key; the later
   backfill-cutover-movement-variants.mjs resolves the spec again from AutoCount and left these rows blank. So the
   lot sits under "ARUNI-(Q), fabric PC151-10" while the stock balance for the same units sits under "ARUNI-(Q),
   no spec": 141 positions with lots above the balance (154 units) and 102 blank positions with the opposite gap
   (production read 23 Nov 2026, Houzs-stock-lots-above-balance-2026-11-23.md, cause 1).

   THE REPAIR. Each lot names its movement (inventory_lots.movement_id), an exact link. A movement is re-keyed to
   its lot's key when: the movement's key is blank, every lot it opened carries the SAME non-blank key, and those
   lots received exactly the movement's qty. Anything else is REFUSED and printed. Only the variant key changes:
   no qty, cost, date or document moves, so every (warehouse, item) total must be identical before and after —
   the plan proves it, the apply re-checks it on a fresh connection.

   MODE=plan (default) applies the change inside a transaction, prints every row, the (warehouse, item) totals
   check and the resulting count of positions above balance, then ROLLS BACK: nothing is written. MODE=apply needs CONFIRM="RE-KEY CUTOVER MOVEMENTS TO THEIR LOT SPEC".
   Env: DATABASE_URL, MODE, CONFIRM, COMPANY (default 1).

   RE-RUN: inert. Candidates need a blank movement key; a re-keyed movement is no longer blank. */
import postgres from 'postgres';
import { lotsAboveBalance, totalsByWarehouseItem, totalsDiffer } from './lib/stock-lots-above-balance.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RE-KEY CUTOVER MOVEMENTS TO THEIR LOT SPEC';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** AC_CUTOVER movements whose lot(s) carry a key the movement does not. */
const CANDIDATES = `
  SELECT m.id::text AS id, m.item_code, w.code AS wh, m.movement_type::text AS mtype, m.qty,
         COALESCE(m.variant_key, '') AS mvk, m.source_doc_no AS doc,
         count(l.id)::int AS lots, COALESCE(sum(l.qty_received), 0)::int AS received,
         count(DISTINCT COALESCE(l.variant_key, ''))::int AS keys, min(COALESCE(l.variant_key, '')) AS lvk
    FROM scm.inventory_movements m
    JOIN scm.inventory_lots l ON l.movement_id = m.id
    LEFT JOIN scm.warehouses w ON w.id = m.warehouse_id
   WHERE m.company_id = $1 AND m.source_doc_type = 'AC_CUTOVER'
   GROUP BY m.id, m.item_code, w.code, m.movement_type, m.qty, m.variant_key, m.source_doc_no
  HAVING bool_or(COALESCE(l.variant_key, '') <> COALESCE(m.variant_key, ''))
   ORDER BY m.item_code, w.code`;

function judge(r) {
  if (r.mvk !== '') return 'the movement already carries a different key';
  if (r.keys !== 1) return `its ${r.lots} lots carry ${r.keys} different keys`;
  if (r.lvk === '') return 'the lot key is blank';
  if (r.received !== Number(r.qty)) return `lots received ${r.received}, the movement moved ${r.qty}`;
  return null;
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO}`);
  const rows = await sql.unsafe(CANDIDATES, [CO]);
  const fix = [], refuse = [];
  for (const r of rows) {
    const why = judge(r);
    if (why) refuse.push({ ...r, why }); else fix.push(r);
  }
  note(`\n=== CANDIDATES: ${rows.length} movement(s) whose lot carries another key ===`);
  for (const r of fix) note(`  FIX    ${r.wh} | ${r.item_code} | ${r.doc} | ${r.mtype} ${r.qty} | '' -> ${r.lvk}`);
  for (const r of refuse) bad(`  REFUSE ${r.wh} | ${r.item_code} | ${r.doc} | ${r.mtype} ${r.qty} | movement '${r.mvk}' lots '${r.lvk}' — ${r.why}`);
  const units = fix.reduce((s, r) => s + Number(r.qty), 0);
  note(`  fixable: ${fix.length} movement(s), ${units} unit(s)   refused: ${refuse.length}`);

  const before = await lotsAboveBalance(sql, CO);
  const totalsBefore = await totalsByWarehouseItem(sql, CO);
  note(`
=== POSITIONS WITH LOTS ABOVE THE BALANCE, NOW ===`);
  note(`  ${before.above} of ${before.positions} positions, ${before.units} units`);

  /* The plan runs the same UPDATEs inside a transaction, measures, and rolls back: the totals and the count it
     prints are what the database answered with the change in place, not arithmetic. */
  const ROLLBACK = new Error('plan rollback');
  let wrote = 0;
  try {
    await sql.begin(async (tx) => {
      for (const r of fix) {
        const back = await tx.unsafe(
          `UPDATE scm.inventory_movements SET variant_key = $2
            WHERE id = $1::uuid AND company_id = $3 AND source_doc_type = 'AC_CUTOVER' AND COALESCE(variant_key, '') = ''
           RETURNING id`, [r.id, r.lvk, CO]);
        wrote += back.length;
      }
      const totalsInTx = await totalsByWarehouseItem(tx, CO);
      const moved = totalsDiffer(totalsBefore, totalsInTx);
      const inTx = await lotsAboveBalance(tx, CO);
      note(`
=== WITH THE CHANGE IN PLACE (${APPLY ? 'committing' : 'rolled back after'}) ===`);
      note(`  rows re-keyed: ${wrote} of ${fix.length}`);
      note(`  (warehouse, item) totals: ${totalsInTx.size}, changed: ${moved.length}${moved.length ? ` — ${moved.slice(0, 10).join(', ')}` : ''}`);
      note(`  positions with lots above the balance: ${inTx.above} of ${inTx.positions}, ${inTx.units} units`);
      if (moved.length) throw new Error(`refusing: ${moved.length} (warehouse, item) total(s) would change`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`
PLAN ONLY: rolled back, nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const totalsAfter = await totalsByWarehouseItem(check, CO);
    const moved = totalsDiffer(totalsBefore, totalsAfter);
    if (moved.length) bad(`  ${moved.length} (warehouse, item) total(s) changed: ${moved.slice(0, 10).join(', ')}`);
    else note(`  all ${totalsAfter.size} (warehouse, item) totals unchanged`);
    const left = await check.unsafe(CANDIDATES, [CO]);
    const stillFixable = left.filter((r) => !judge(r)).length;
    note(`  movements whose lot carries another key: ${left.length} (was ${rows.length}); fixable left: ${stillFixable}; refused: ${refuse.length}`);
    for (const r of fix.slice(0, 5)) {
      const [row] = await check.unsafe(`SELECT variant_key FROM scm.inventory_movements WHERE id = $1::uuid`, [r.id]);
      note(`  ${r.item_code} ${r.id}: movement key now '${row?.variant_key}', lot key '${r.lvk}'`);
    }
    const after = await lotsAboveBalance(check, CO);
    note(`  positions with lots above the balance: ${after.above} of ${after.positions}, ${after.units} units (was ${before.above}, ${before.units})`);
    if (moved.length || stillFixable) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
