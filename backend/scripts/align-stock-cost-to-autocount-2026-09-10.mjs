#!/usr/bin/env node
/* align-stock-cost-to-autocount-2026-09-10 — give our stock the cost the account
 * book still carries for it, layer by layer.
 *
 * Owner, 2026-09-10: 「最重要的是一定要跟 AutoCount 一样，要不然我的 balance sheet
 * 之后做的时候会不准、不一样」, and on being shown the plan: 「是的」.
 *
 * WHAT IS WRONG TODAY. Measured against the book (run 34436681698): on the 961
 * cells where AutoCount's own cost layers add up to its own balance, the book
 * holds 7,605 units worth RM 1,485,503 and we hold 10,240 units worth
 * RM 2,484,147. Most of that gap is NOT stock we do not have — it is cost we
 * priced too high:
 *
 *   AK-SLEEP ESSENTIAL 7 HOLES   1,132 in the book vs 1,130 here   RM 3,158 vs RM 20,340
 *   DL-SERENITY LTX PIL             94 vs 94                       RM 0     vs RM 17,672
 *   NTYR-TECHGEL MEM PIL           493 vs 493                      RM 25,039 vs RM 40,426
 *   ELECTRIC ADJUSTABLE BED (S)     32 vs 32                       RM 22,273 vs RM 37,664
 *
 * Same quantity, several times the value. The cutover costed each lot from the
 * RECEIPT it came from; AutoCount values what is LEFT, and after FIFO has eaten
 * the early layers what remains is not what the receipt cost.
 *
 * ── WHY LAYER BY LAYER, AND NOT BY FORCING THE TOTAL ─────────────────────
 * Forcing our total to equal the book's would set a unit cost that is wrong per
 * unit wherever the quantity ALSO differs: `CODY-(Q)` is 36 in the book and 65
 * here, so a forced total gives RM 124.60 a piece for something that costs
 * RM 225. That is making the evidence say what I want, and it buries a real
 * stock difference inside a cost field where nobody will find it again.
 *
 * And the owner has already ruled once that costing follows FIFO with each lot
 * carrying its own cost — 「不是跟着FIFO的嘛？」 — so one blended figure per item
 * is the answer he rejected. `UTDStockCostDTL` holds the layers the book still
 * has, in `Seq` order. Copying those across keeps both properties at once: the
 * value equals the book's because the numbers ARE the book's, and the layering
 * survives.
 *
 * ── WHAT IT REFUSES TO TOUCH, AND WHY EACH REFUSAL EARNS ITS PLACE ───────
 *   QUANTITY DISAGREES   if our on-hand for a cell is not the book's balance,
 *                        the cell is REPORTED and skipped. Re-costing it would
 *                        hide a stock problem behind a money change.
 *   LAYER GAP            112 cells whose layers do not add up to their own
 *                        balance. AutoCount's value there is a number this
 *                        channel cannot reproduce; writing from it would be
 *                        inventing one.
 *   SERVICE              owner 2026-09-09: 「那个 Service 的东西…我们不用理它」.
 *   SOFA                 excluded by construction and stated so it is not
 *                        mistaken for an oversight: the book prices a WHOLE sofa
 *                        (`AMN-SF9058 SOFA` -> our `9058-1S`) while our stock is
 *                        per compartment (`9058-CNR`), so no lot matches the
 *                        book's code and none is written. Sofa costing stays
 *                        with cost-zero-cutover-lots, which splits the whole-sofa
 *                        price by the owner's own compartment weights.
 *
 * A NEGATIVE balance is followed, not skipped — owner 2026-09-10:
 * 「如果是负库存，你也是要跟着负库存的」.
 *
 * ── HOW A LAYER LANDS ON A LOT ───────────────────────────────────────────
 * Our lots are read oldest-first, which is the order the book's remaining layers
 * are in (`Seq` ascending is oldest-still-held first). Each lot takes the
 * quantity-weighted cost of the slice of layers it spans. Because the totals
 * agree before any write, the sum is preserved — the only movement is integer
 * rounding on `unit_cost_sen`, which is measured per cell and REPORTED, never
 * absorbed by quietly adjusting a lot to make the arithmetic close.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every cell, both totals and the
 *                     per-lot before/after.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE names the exact cost being replaced, so a lot re-costed since
 *   this was measured matches nothing and is reported.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: every lot
 *   this run touched holds its intended cost, no lot went negative, quantities
 *   and lot count are unchanged, and the company's inventory value moved by
 *   exactly the amount planned.
 *
 * RE-RUN: idempotent — a second run finds the costs already equal to the book's
 * and reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)   TOP (default 40, how many cells to print)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { SALESLOC, SERVICE_GROUPS } from './lib/ac-stock-compare.mjs';
import { readMappingCsv, normCode } from './lib/ac-mapping-csv.mjs';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'align stock cost to autocount 2026-09-10';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const TOP = Number(process.env.TOP || 40);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const norm = normCode;
const rm = (sen) => `RM ${(sen / 100).toFixed(2)}`;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}
const SNAP = path.join(here, 'data', 'ac-remaining-layers-2026-09-10.json.gz');
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing — it is the AutoCount layer extraction and `
    + 'this runner cannot reach the book. Nothing was written.');
  process.exit(1);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8').replace(/^﻿/, ''));
const mapping = readMappingCsv(fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8'));
const erpCodeOf = (ac) => norm(mapping.get(norm(ac))?.erp || ac);
const groupOf = (ac) => (mapping.get(norm(ac))?.cat ?? '');

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`MODE=${MODE}  company ${CO}   AutoCount layers exported ${snap.exported_at}`);
  log(`${snap.cells.length} cell(s) in the book, ${snap.cells.filter((c) => !c.layer_gap).length} whose layers add up`);

  const whs = await sql`
    SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(whs.map((w) => [norm(w.code), w]));
  const whByName = new Map(whs.map((w) => [norm(w.name), w]));
  const resolveWh = (loc) => {
    const target = SALESLOC[norm(loc)] ?? loc;
    return whByCode.get(norm(target)) ?? whByName.get(norm(target)) ?? null;
  };
  log(`warehouses: ${whs.length}`);

  const lots = await sql`
    SELECT l.id, l.item_code, l.warehouse_id, l.qty_remaining::numeric AS qty,
           coalesce(l.unit_cost_sen, 0)::bigint AS cost,
           to_char(l.received_at, 'YYYY-MM-DD') AS at
      FROM scm.inventory_lots l
     WHERE l.company_id = ${CO} AND l.qty_remaining <> 0
     ORDER BY l.received_at, l.id`;
  const ourCells = new Map();
  for (const l of lots) {
    const k = `${norm(l.item_code)}|${l.warehouse_id}`;
    if (!ourCells.has(k)) ourCells.set(k, []);
    ourCells.get(k).push(l);
  }
  log(`our open lots: ${lots.length} across ${ourCells.size} cell(s)`);

  const plan = [];
  const skip = new Map();
  const bump = (k, n) => skip.set(k, (skip.get(k) ?? 0) + (n ?? 1));
  const qtyDiff = [];

  for (const c of snap.cells) {
    if (c.layer_gap) { bump("AutoCount's own layers do not add up to its own balance"); continue; }
    if (SERVICE_GROUPS.has(norm(c.group))) { bump('service item — the owner ruled it out of scope'); continue; }
    if (!c.layers.length) { bump('the book holds no cost layer for this cell'); continue; }
    const wh = resolveWh(c.location ?? '');
    if (!wh) { bump(`AutoCount location has no warehouse here: ${c.location}`); continue; }
    const code = erpCodeOf(c.item);
    const ours = ourCells.get(`${code}|${wh.id}`) ?? [];
    if (!ours.length) { bump('we hold no open lot for this item in that warehouse'); continue; }

    const ourQty = ours.reduce((a, l) => a + Number(l.qty), 0);
    if (Math.abs(ourQty - c.bal_qty) > 0.0001) {
      qtyDiff.push({ code, loc: c.location, wh: wh.code, book: c.bal_qty, ours: ourQty,
        bookSen: c.value_sen, oursSen: ours.reduce((a, l) => a + Math.round(Number(l.qty) * Number(l.cost)), 0) });
      bump('quantity disagrees — re-costing would hide a stock difference behind a money change');
      continue;
    }

    /* Walk the book's remaining layers, oldest first, against our lots in the
       same order. Each lot takes the quantity-weighted cost of the slice it
       spans. `Seq` ascending is oldest-still-held first, which is the order our
       lots come back in. */
    const seq = [...c.layers].sort((a, b) => a.seq - b.seq).map((x) => ({ ...x }));
    let li = 0;
    const moves = [];
    for (const lot of ours) {
      let need = Number(lot.qty);
      let sen = 0;
      let taken = 0;
      const sign = need < 0 ? -1 : 1;
      need = Math.abs(need);
      while (need > 0.0001 && li < seq.length) {
        const avail = Math.abs(seq[li].qty);
        if (avail <= 0.0001) { li += 1; continue; }
        const take = Math.min(avail, need);
        sen += take * seq[li].cost_sen;
        taken += take;
        seq[li].qty = (Math.abs(seq[li].qty) - take) * Math.sign(seq[li].qty || 1);
        need -= take;
        if (Math.abs(seq[li].qty) <= 0.0001) li += 1;
      }
      if (taken <= 0.0001) continue;
      const unit = Math.round(sen / taken);
      if (unit === Number(lot.cost)) continue;
      moves.push({ id: lot.id, code: lot.item_code, wh: wh.code, at: lot.at,
        qty: Number(lot.qty), from: Number(lot.cost), to: unit, sign });
    }
    if (!moves.length) { bump('already equal to the book'); continue; }

    const beforeSen = ours.reduce((a, l) => a + Math.round(Number(l.qty) * Number(l.cost)), 0);
    const afterSen = ours.reduce((a, l) => {
      const m = moves.find((x) => x.id === l.id);
      return a + Math.round(Number(l.qty) * (m ? m.to : Number(l.cost)));
    }, 0);
    plan.push({ code, loc: c.location, wh: wh.code, qty: c.bal_qty,
      bookSen: c.value_sen, beforeSen, afterSen, moves });
  }

  const movesAll = plan.flatMap((p) => p.moves);
  const before = plan.reduce((a, p) => a + p.beforeSen, 0);
  const after = plan.reduce((a, p) => a + p.afterSen, 0);
  const book = plan.reduce((a, p) => a + p.bookSen, 0);
  log(`\n=== WOULD RE-COST: ${movesAll.length} lot(s) across ${plan.length} cell(s) ===`);
  log(`  our value on those cells   ${rm(before).padStart(16)}`);
  log(`  after, matching the book   ${rm(after).padStart(16)}`);
  log(`  the book's own figure      ${rm(book).padStart(16)}`);
  log(`  rounding drift vs the book ${rm(after - book).padStart(16)}   (integer sen per lot)`);
  log(`  inventory value change     ${rm(after - before).padStart(16)}`);

  const worst = [...plan].sort((a, b) => Math.abs(b.afterSen - b.beforeSen) - Math.abs(a.afterSen - a.beforeSen));
  log('\n  biggest movers:');
  for (const p of worst.slice(0, TOP)) {
    log(`    ${p.code.slice(0, 30).padEnd(30)} ${p.wh.padEnd(14)} ${String(p.qty).padStart(6)}u  `
      + `${rm(p.beforeSen).padStart(13)} -> ${rm(p.afterSen).padStart(13)}   book ${rm(p.bookSen)}`);
    for (const m of p.moves.slice(0, 3)) {
      log(`        lot ${m.at ?? '-'}  ${String(m.qty).padStart(5)}u   ${rm(m.from)} -> ${rm(m.to)}`);
    }
    if (p.moves.length > 3) log(`        … ${p.moves.length - 3} more lot(s)`);
  }

  log('\n  LEFT ALONE:');
  for (const [k, n] of [...skip].sort((a, b) => b[1] - a[1])) log(`    ${String(n).padStart(4)} cell(s) — ${k}`);

  const qd = qtyDiff.sort((a, b) => Math.abs(b.oursSen - b.bookSen) - Math.abs(a.oursSen - a.bookSen));
  log(`\n  QUANTITY DISAGREES — reported, never re-costed (${qd.length} cell(s)):`);
  for (const q of qd.slice(0, TOP)) {
    log(`    ${q.code.slice(0, 30).padEnd(30)} ${q.wh.padEnd(14)} book ${String(q.book).padStart(7)}u vs ours ${String(q.ours).padStart(7)}u   `
      + `${rm(q.bookSen)} vs ${rm(q.oursSen)}`);
  }
  if (qd.length > TOP) log(`    … ${qd.length - TOP} more`);

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [was] = await sql`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::text AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::text AS value_sen
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining <> 0`;

  let wrote = 0;
  for (const m of movesAll) {
    const done = await sql`
      UPDATE scm.inventory_lots SET unit_cost_sen = ${m.to}
       WHERE id = ${m.id} AND coalesce(unit_cost_sen, 0) = ${m.from}
      RETURNING id`;
    wrote += done.length;
  }
  log(`\nAPPLIED: ${wrote} lot(s) re-costed.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [now] = await check`
    SELECT count(*)::int AS lots, coalesce(sum(qty_remaining), 0)::text AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::text AS value_sen,
           count(*) FILTER (WHERE unit_cost_sen < 0)::int AS negative
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining <> 0`;
  let landed = 0;
  for (const m of movesAll) {
    const [row] = await check`
      SELECT coalesce(unit_cost_sen, 0)::bigint AS c FROM scm.inventory_lots WHERE id = ${m.id}`;
    if (row && Number(row.c) === m.to) landed += 1;
  }
  await check.end();

  const expected = BigInt(was.value_sen) + BigInt(after - before);
  const ok = {
    'every lot this run touched holds the cost the book gave it': landed === wrote,
    'no lot carries a negative cost': now.negative === 0,
    'the lot count is unchanged': now.lots === was.lots,
    'quantities are unchanged': now.qty === was.qty,
    'inventory value moved by exactly what was planned': BigInt(now.value_sen) === expected,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  log(`  inventory value ${rm(Number(was.value_sen))} -> ${rm(Number(now.value_sen))}`);
  log(`  ${landed} of ${movesAll.length} planned lot(s) now carry the book's cost`);
  if (bad) { console.error('VERIFY FAILED.'); process.exit(1); }
  log("VERIFY OK — one column written, no stock moved, and the value is the book's own.");
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
