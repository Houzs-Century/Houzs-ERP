#!/usr/bin/env node
/* Clear the stock rows left on five non-stock service codes: TRANSPORTATION CHARGES, DISPOSE, MISC, STORAGE,
   RC-CUS (owner approved 23 Nov 2026).

   WHY. All five are category SERVICE in the product list and the system already keeps them out of stock (a
   10 Nov receipt of TRANSPORTATION CHARGES booked none). Their rows are leftovers: the 29 Aug AutoCount cutover
   wrote stock adjustments for them, and two September receipts of TRANSPORTATION CHARGES booked lots. Read
   23 Nov: balances from -1,714 to +1 across KL / PG / SBH / SRW / HQ, and three open lots worth RM 707.15
   (TRANSPORTATION CHARGES RM 546.15 + RM 65.00, RC-CUS RM 96.00).

   THE HOUSE PATH. Houzs posts no journal per stock adjustment: stock value reaches the ledger once a month,
   from the movements, through the stock close (acc/stock-close.ts: Dr STOCK - <bucket> / Cr STOCKS AT THE END -
   <bucket>, re-checked daily). So the write-off is two ordinary ADJUSTMENT movements per (warehouse, item,
   variant) position, the shape the manual Stock Adjustment and the earlier cutover repairs use:
     1. if lots are open: ADJUSTMENT -<open qty>, per batch, so the FIFO trigger consumes exactly those lots and
        books their cost on the movement — this is the value that leaves the month's closing stock;
     2. then one ADJUSTMENT that brings the balance to 0. A positive one opens a lot, which is closed at once
        and valued 0 (the same close fn_reverse_do_out does for its balance-only add-back), so it adds no value.
   Notes on every row: "Cutover leftovers on non-stock service code, cleared (owner approved 23 Nov 2026)".

   MODE=plan (default) makes the changes inside a transaction, prints every position before and after (balance,
   open lots, movement value) and the RM written off per code and per stock bucket, then ROLLS BACK.
   MODE=apply needs CONFIRM="CLEAR SERVICE CODE STOCK" and re-reads on a fresh connection.
   Env: DATABASE_URL, MODE, CONFIRM, COMPANY (default 1).

   RE-RUN: inert. A cleared position has balance 0 and no open lot, so it writes nothing. */
import postgres from 'postgres';
import { stockBucketOf } from '../src/scm/lib/stock-bucket.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'CLEAR SERVICE CODE STOCK';
const CODES = ['TRANSPORTATION CHARGES', 'DISPOSE', 'MISC', 'STORAGE', 'RC-CUS'];
const DOC_NO = 'SERVICE-STOCK-CLEAR-2026-11-23';
const NOTES = 'Cutover leftovers on non-stock service code, cleared (owner approved 23 Nov 2026)';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Per position: balance, open lots and movement value (the stock close's signedCost). */
const POSITIONS = `
  WITH m AS (
    SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk,
           SUM(CASE movement_type::text WHEN 'OUT' THEN -qty ELSE qty END) AS bal,
           SUM(CASE movement_type::text WHEN 'IN' THEN abs(COALESCE(total_cost_sen, 0))
                                        WHEN 'OUT' THEN -abs(COALESCE(total_cost_sen, 0))
                                        ELSE CASE WHEN qty >= 0 THEN abs(COALESCE(total_cost_sen, 0)) ELSE -abs(COALESCE(total_cost_sen, 0)) END END) AS value
      FROM scm.inventory_movements WHERE company_id = $1 AND item_code = ANY ($2::text[]) GROUP BY 1, 2, 3),
  l AS (
    SELECT warehouse_id, item_code, COALESCE(variant_key, '') AS vk, SUM(qty_remaining) AS lots,
           SUM(qty_remaining::bigint * COALESCE(unit_cost_sen, 0)) AS lot_value
      FROM scm.inventory_lots WHERE company_id = $1 AND item_code = ANY ($2::text[]) AND qty_remaining > 0 GROUP BY 1, 2, 3)
  SELECT COALESCE(m.warehouse_id, l.warehouse_id)::text AS warehouse_id, COALESCE(m.item_code, l.item_code) AS item_code,
         COALESCE(m.vk, l.vk) AS vk, COALESCE(m.bal, 0)::int AS bal, COALESCE(l.lots, 0)::int AS lots,
         COALESCE(l.lot_value, 0)::bigint AS lot_value, COALESCE(m.value, 0)::bigint AS value
    FROM m FULL JOIN l ON l.warehouse_id = m.warehouse_id AND l.item_code = m.item_code AND l.vk = m.vk
   ORDER BY 2, 1`;

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (rolled back)'} company=${CO}`);

  const cats = await sql`SELECT code, upper(COALESCE(category::text, '')) AS cat FROM scm.mfg_products WHERE company_id = ${CO} AND code = ANY (${CODES})`;
  const notService = CODES.filter((c) => !cats.some((r) => r.code === c && r.cat === 'SERVICE'));
  if (notService.length) { bad(`refusing: not category SERVICE in the product list: ${notService.join(', ')}`); process.exitCode = 2; await sql.end({ timeout: 5 }); return; }
  note(`  all ${CODES.length} codes are category SERVICE`);

  const whs = await sql`SELECT id::text AS id, code, type, stock_bucket FROM scm.warehouses WHERE company_id = ${CO}`;
  const whById = new Map(whs.map((w) => [w.id, w]));
  const label = (id) => whById.get(id)?.code ?? id.slice(0, 8);
  const bucket = (id) => stockBucketOf(whById.get(id) ?? null);

  const before = (await sql.unsafe(POSITIONS, [CO, CODES])).filter((p) => p.bal !== 0 || p.lots !== 0 || Number(p.value) !== 0);
  note(`\n=== BEFORE: ${before.length} position(s) ===`);
  for (const p of before) note(`  ${p.item_code} | ${label(p.warehouse_id)} (${bucket(p.warehouse_id)}) | balance ${p.bal} | open lots ${p.lots} (${rm(p.lot_value)}) | movement value ${rm(p.value)}`);

  const ROLLBACK = new Error('plan rollback');
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  try {
    await sql.begin(async (tx) => {
      const insert = (p, qty, batch) => tx.unsafe(
        `INSERT INTO scm.inventory_movements (company_id, movement_type, warehouse_id, item_code, variant_key, qty, unit_cost_sen,
                                              batch_no, source_doc_type, source_doc_no, notes, movement_date, reason_code)
         VALUES ($1, 'ADJUSTMENT', $2::uuid, $3, $4, $5, 0, $6, 'ADJUSTMENT', $7, $8, $9::date, 'WRITEOFF')
         RETURNING id::text AS id, total_cost_sen`,
        [CO, p.warehouse_id, p.item_code, p.vk, qty, batch, DOC_NO, NOTES, today]);
      for (const p of before) {
        const lots = await tx.unsafe(
          `SELECT batch_no, SUM(qty_remaining)::int AS q FROM scm.inventory_lots
            WHERE company_id = $1 AND warehouse_id = $2::uuid AND item_code = $3 AND COALESCE(variant_key, '') = $4 AND qty_remaining > 0
            GROUP BY batch_no`, [CO, p.warehouse_id, p.item_code, p.vk]);
        for (const l of lots) await insert(p, -l.q, l.batch_no);
        const [b] = await tx.unsafe(
          `SELECT COALESCE(SUM(CASE movement_type::text WHEN 'OUT' THEN -qty ELSE qty END), 0)::int AS bal FROM scm.inventory_movements
            WHERE company_id = $1 AND warehouse_id = $2::uuid AND item_code = $3 AND COALESCE(variant_key, '') = $4`,
          [CO, p.warehouse_id, p.item_code, p.vk]);
        if (b.bal !== 0) {
          const [m] = await insert(p, -b.bal, null);
          if (-b.bal > 0) {
            /* Balance-only add-back: the lot the trigger opened is closed and the row valued 0. */
            await tx.unsafe(`UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE movement_id = $1::uuid`, [m.id]);
            await tx.unsafe(`UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = $1::uuid`, [m.id]);
          }
        }
      }
      const after = await tx.unsafe(POSITIONS, [CO, CODES]);
      const byKey = new Map(after.map((p) => [`${p.warehouse_id}|${p.item_code}|${p.vk}`, p]));
      note(`\n=== AFTER (${APPLY ? 'committing' : 'rolled back after'}) ===`);
      const perCode = new Map(), perBucket = new Map();
      let left = 0;
      for (const p of before) {
        const a = byKey.get(`${p.warehouse_id}|${p.item_code}|${p.vk}`) ?? { bal: 0, lots: 0, value: 0 };
        const off = Number(p.value) - Number(a.value);
        perCode.set(p.item_code, (perCode.get(p.item_code) ?? 0) + off);
        perBucket.set(bucket(p.warehouse_id), (perBucket.get(bucket(p.warehouse_id)) ?? 0) + off);
        if (a.bal !== 0 || a.lots !== 0) left += 1;
        note(`  ${p.item_code} | ${label(p.warehouse_id)} | balance ${p.bal} -> ${a.bal} | open lots ${p.lots} -> ${a.lots} | movement value ${rm(p.value)} -> ${rm(a.value)}`);
      }
      note(`\n=== WRITTEN OFF (leaves closing stock at the next stock close) ===`);
      for (const [c, v] of perCode) note(`  ${c}: ${rm(v)}`);
      for (const [b, v] of perBucket) if (v) note(`  stock bucket ${b}: ${rm(v)}`);
      note(`  total: ${rm([...perCode.values()].reduce((s, v) => s + v, 0))}`);
      if (left) throw new Error(`refusing: ${left} position(s) not at balance 0 / no open lot after the change`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`\nPLAN ONLY: rolled back, nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const after = await check.unsafe(POSITIONS, [CO, CODES]);
    const notClear = after.filter((p) => p.bal !== 0 || p.lots !== 0);
    for (const p of notClear) bad(`  ${p.item_code} | ${label(p.warehouse_id)}: balance ${p.bal}, open lots ${p.lots}`);
    note(`  positions not at balance 0 / no open lot: ${notClear.length} (was ${before.length})`);
    const rows = await check`SELECT count(*)::int AS n FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_no = ${DOC_NO} AND notes = ${NOTES}`;
    note(`  write-off movements on file under ${DOC_NO}: ${rows[0].n}`);
    if (notClear.length) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
