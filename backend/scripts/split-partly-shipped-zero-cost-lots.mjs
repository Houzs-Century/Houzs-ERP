#!/usr/bin/env node
/* Put a real cost on the 2,590 units of stock the zero-cost backfill could not touch.

   WHAT THE OWNER ASKED FOR, 2026-09-04: 「库存也要」 — do the stock too — and his
   reason in his own words: 「要不然我们到时开 SI costing 全部不对了」. In plain
   terms: 2,590 pillows and mattress protectors are sitting in the warehouse
   with a cost of ZERO. Every one of them that ships will book no cost at all,
   so the invoice reads as 100% profit and the profit report is wrong by the
   whole purchase price.

   WHY THEY WERE LEFT BEHIND. backfill-zero-cost-lots.mjs ran against production
   on 2026-09-04 (run 33849184319) and costed 264 lots / 2,203 units / RM
   841,956.14. It refuses any lot that is not FULLY unconsumed, on purpose: one
   `unit_cost_sen` is shared by every unit in the row, so writing a cost onto a
   lot that has already shipped some units restates what those units went out
   at — settled cost of goods sold, rewritten after the fact. That rule left two
   groups behind, and they are NOT the same thing:

     • 140 lots / 237 units — no purchase price anywhere in AutoCount. Gifts
       with purchase, demo and display pieces. Zero IS their cost. LEFT ALONE,
       and this script leaves them alone too (reason `no-purchase-price`).
     • 34 lots / 2,590 units — a known purchase cost, cutover lots, shipped a
       little and kept the rest. THIS SCRIPT.

   WHAT IT DOES. It splits the row in two rather than overwriting it:

     before   AK-SLEEP ESSENTIAL 7 HOLES   received 633, on hand 628, cost 0
     after    (same lot id)                received   5, on hand   0, cost 0
              (new lot id)                 received 628, on hand 628, cost RM18

   The 5 units that already shipped keep their own row, their own id, their own
   zero cost, and every consumption/COGS row still points at it. The 628 still
   on the shelf get a row of their own carrying the real purchase price.

   WHY A SPLIT IS SAFE HERE — read on the live database 2026-09-04, not assumed:
     · scm.v_cogs_entries reads c.unit_cost_sen / c.total_cost_sen out of
       scm.inventory_lot_consumptions. Settled COGS is a SNAPSHOT on the
       consumption row, so nothing this script writes can reach it.
     · scm.v_inventory_value is SUM(qty_remaining * unit_cost_sen) over
       scm.inventory_lots, so value moves by exactly (on hand x cost) and by
       nothing else.
     · The FIFO trigger is `AFTER INSERT ON scm.inventory_movements` only
       (pg_trigger, checked). Inserting a LOT fires nothing, and UPDATEing a
       movement fires nothing.
     · FIFO order is `received_at ASC, id ASC` (scm.fn_consume_fifo). The new
       row inherits received_at verbatim. Zero of the 34 buckets has another
       open lot at the same instant, so the id tiebreak never decides anything
       here — measured, not assumed.

   THE RECEIPT MOVEMENT is re-valued at what is actually capitalised — on-hand x
   cost — NOT at received x cost. The consumed units left at zero and that is
   settled, so booking the whole receipt would put money on the books that no
   stock holds. unit_cost_sen x qty therefore does not equal total_cost_sen on
   these rows, deliberately, which is already the convention the OUT branch uses
   after a partial short (migration 0154). Do not "fix" it.

   WHAT IT REFUSES, per lot, rather than forcing: a lot already carrying a cost,
   a fully unconsumed lot (that one belongs to the other script), a lot whose
   consumption rows disagree with its own qty_received - qty_remaining, a
   zero-cost lot whose shipped units somehow booked real money, and any lot
   whose numbers moved between the plan and the write.

   MODE=plan (default) is STRICTLY READ-ONLY — SELECT only, no transaction, no
   rehearsal write. MODE=apply requires CONFIRM="I HAVE REVIEWED THE PLAN" and
   writes each lot in its own transaction, asserting inside that transaction
   that quantity held, that settled COGS is byte-identical, and that inventory
   value moved by exactly the planned amount. Any one of those fails and that
   lot rolls back on its own.

   RE-RUN: inert. A second run finds nothing — the closed half now has
   qty_remaining = 0 and the open half has a non-zero unit_cost_sen, and the
   selection requires qty_remaining > 0 AND unit_cost_sen = 0 AND
   qty_remaining <> qty_received. It re-plans, reports 0 lots, and writes
   nothing. */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { conservation, normCode, planSplits } from './lib/split-partly-shipped-lots.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }

const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE PLAN';
const CO = Number(process.env.COMPANY || 1);
const SOURCE = process.env.SOURCE_DOC_TYPE || 'AC_CUTOVER';

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

/** Each item's most recent PRICED AutoCount purchase-invoice line, keyed on the
 *  ERP code — the SAME two files and the SAME "take the highest when several
 *  AutoCount codes map to one ERP code" rule backfill-zero-cost-lots.mjs used,
 *  so the two runs cannot put different costs on the same SKU. */
function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function loadCosts() {
  const dir = path.join(here, 'data');
  for (const f of ['ac-last-purchase-costs.json.gz', 'autocount-erp-mapping-1561.csv']) {
    if (!fs.existsSync(path.join(dir, f))) { bad(`missing ${f} — cannot cost anything without it`); process.exit(2); }
  }
  const costs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'ac-last-purchase-costs.json.gz'))).toString('utf8').replace(/^﻿/, ''));
  const csv = fs.readFileSync(path.join(dir, 'autocount-erp-mapping-1561.csv'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  csv.shift();
  const acToErp = new Map();
  for (const ln of csv) { const f = parseCsvLine(ln); if (f[0]) acToErp.set(normCode(f[0]), (f[1] || '').trim()); }
  const best = new Map();
  for (const r of costs) {
    const erp = acToErp.get(normCode(r.ItemCode));
    if (!erp || !(r.LastCost > 0)) continue;
    const k = normCode(erp);
    const sen = Math.round(Number(r.LastCost) * 100);
    if (!best.has(k) || sen > best.get(k)) best.set(k, sen);
  }
  return best;
}

const BUCKET_VALUE = (db, lot) => db`
  SELECT COALESCE(SUM(qty_remaining), 0)::bigint                        AS qty_remaining,
         COALESCE(SUM(qty_received), 0)::bigint                         AS qty_received,
         COALESCE(SUM(qty_remaining::bigint * unit_cost_sen), 0)::bigint AS value_sen
    FROM scm.inventory_lots
   WHERE company_id = ${CO} AND warehouse_id = ${lot.warehouseId}
     AND item_code = ${lot.itemCode} AND variant_key = ${lot.variantKey}`;

/* The settled cost of goods sold for this item, in this warehouse, as a DIGEST
   of the actual rows — id, lot, qty, unit cost, total cost, instant — not as a
   count. A count of consumption rows would read 1 of 1 while a cost inside one
   of them changed, which is exactly the trap the jsonb-double-encoding repair
   fell into on 2026-08-13. */
const COGS_DIGEST = (db, lot) => db`
  SELECT COUNT(*)::int AS rows,
         COALESCE(SUM(s.qty), 0)::bigint  AS qty,
         COALESCE(SUM(s.cost), 0)::bigint AS cost_sen,
         MD5(COALESCE(STRING_AGG(s.k, '|' ORDER BY s.k), '')) AS digest
    FROM (
      SELECT c.qty_consumed AS qty, c.total_cost_sen AS cost,
             c.id::text || ':' || c.lot_id::text || ':' || c.qty_consumed::text || ':'
             || c.unit_cost_sen::text || ':' || c.total_cost_sen::text || ':'
             || EXTRACT(EPOCH FROM c.consumed_at)::text AS k
        FROM scm.inventory_lot_consumptions c
       WHERE c.company_id = ${CO} AND c.warehouse_id = ${lot.warehouseId}
         AND c.item_code = ${lot.itemCode} AND c.variant_key = ${lot.variantKey}
    ) s`;

const snapshot = async (db, lot) => {
  const [v] = await BUCKET_VALUE(db, lot);
  const [c] = await COGS_DIGEST(db, lot);
  return {
    qtyRemaining: Number(v.qty_remaining), qtyReceived: Number(v.qty_received),
    valueSen: Number(v.value_sen), cogsDigest: c.digest, cogsRows: c.rows,
    cogsQty: Number(c.qty), cogsCostSen: Number(c.cost_sen),
  };
};

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (read-only — no transaction is opened, nothing is written)'} company=${CO} source_doc_type=${SOURCE}`);

  const costByItem = loadCosts();
  note(`items with a known AutoCount purchase cost: ${costByItem.size}`);

  const rows = await sql`
    SELECT l.id, l.item_code, l.variant_key, l.warehouse_id, l.product_name,
           l.qty_received, l.qty_remaining, COALESCE(l.unit_cost_sen, 0) AS unit_cost_sen,
           l.received_at, l.movement_id,
           COALESCE(c.qty, 0)::int     AS consumed_qty,
           COALESCE(c.cost, 0)::bigint AS consumed_cost_sen
      FROM scm.inventory_lots l
      LEFT JOIN LATERAL (
        SELECT SUM(qty_consumed) AS qty, SUM(total_cost_sen) AS cost
          FROM scm.inventory_lot_consumptions WHERE lot_id = l.id
      ) c ON TRUE
     WHERE l.company_id = ${CO} AND l.source_doc_type = ${SOURCE}
       AND COALESCE(l.unit_cost_sen, 0) = 0
       AND l.qty_remaining > 0
       AND l.qty_remaining <> l.qty_received
     ORDER BY l.qty_remaining DESC`;

  const lots = rows.map((r) => ({
    lotId: r.id, itemCode: r.item_code, variantKey: r.variant_key ?? '',
    warehouseId: r.warehouse_id, productName: r.product_name,
    qtyReceived: Number(r.qty_received), qtyRemaining: Number(r.qty_remaining),
    unitCostSen: Number(r.unit_cost_sen), consumedQty: Number(r.consumed_qty),
    consumedCostSen: Number(r.consumed_cost_sen),
    receivedAt: r.received_at, movementId: r.movement_id,
  }));
  note(`partly-shipped zero-cost ${SOURCE} lots still on hand: ${lots.length}`);

  const { plan, refused, totals } = planSplits(lots, costByItem);
  const byLot = new Map(lots.map((l) => [l.lotId, l]));

  note('');
  note('=== PLAN ===');
  note(`  lots to split ........ ${totals.lots}`);
  note(`  units to be costed ... ${totals.splitUnits}   (the stock still on the shelf)`);
  note(`  units left settled ... ${totals.keepUnits}   (already shipped at zero — NOT touched)`);
  note(`  inventory value added  ${rm(totals.valueDeltaSen)}`);
  note('');
  note(`  ${'item'.padEnd(32)} ${'recv'.padStart(5)} ${'ship'.padStart(5)} ${'keep'.padStart(5)} ${'unit cost'.padStart(12)} ${'value added'.padStart(14)}`);
  for (const p of plan) {
    note(`  ${String(p.itemCode).slice(0, 32).padEnd(32)} ${String(p.keepQty + p.splitQty).padStart(5)} ${String(p.keepQty).padStart(5)} ${String(p.splitQty).padStart(5)} ${rm(p.splitUnitCostSen).padStart(12)} ${rm(p.valueDeltaSen).padStart(14)}`);
  }
  if (refused.length) {
    note('');
    note(`=== REFUSED (${refused.length}) — reported, never forced ===`);
    for (const r of refused) note(`  ${String(r.itemCode).slice(0, 32).padEnd(32)} ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
  }

  /* The arithmetic, asserted rather than trusted. A row count is not a shape. */
  const badRow = plan.find((p) => {
    const l = byLot.get(p.lotId);
    return p.keepQty + p.splitQty !== l.qtyReceived
      || p.keepQtyRemaining + p.splitQtyRemaining !== l.qtyRemaining
      || p.valueDeltaSen !== p.splitQty * p.splitUnitCostSen;
  });
  if (badRow) { bad(`plan for lot ${badRow.lotId} does not conserve quantity or value — refusing`); process.exit(1); }
  if (totals.valueDeltaSen !== plan.reduce((s, p) => s + p.splitQty * p.splitUnitCostSen, 0)) {
    bad('plan total does not equal the sum of its rows — refusing'); process.exit(1);
  }

  // ── what each bucket looks like NOW, and what the plan says it becomes ────
  note('');
  note('=== BEFORE / AFTER, per lot (read now; re-read and re-asserted inside each write txn) ===');
  const before = new Map();
  for (const p of plan) {
    const l = byLot.get(p.lotId);
    const snap = await snapshot(sql, l);
    before.set(p.lotId, snap);
    note(`  ${String(p.itemCode).slice(0, 30).padEnd(30)} on hand ${String(snap.qtyRemaining).padStart(5)} -> ${String(snap.qtyRemaining).padStart(5)} | value ${rm(snap.valueSen).padStart(14)} -> ${rm(snap.valueSen + p.valueDeltaSen).padStart(14)} | settled COGS ${snap.cogsRows} row(s), ${snap.cogsQty} units, ${rm(snap.cogsCostSen)} -> unchanged`);
  }
  const [tot] = await sql`
    SELECT COALESCE(SUM(qty_remaining::bigint * unit_cost_sen), 0)::bigint AS value_sen,
           COALESCE(SUM(qty_remaining), 0)::bigint AS qty
      FROM scm.inventory_lots WHERE company_id = ${CO}`;
  note('');
  note(`  company ${CO} inventory: ${tot.qty} units, ${rm(tot.value_sen)}  ->  ${rm(Number(tot.value_sen) + totals.valueDeltaSen)} after this run (+${rm(totals.valueDeltaSen)})`);

  if (!APPLY) {
    note('');
    note('PLAN ONLY — nothing was written and no transaction was opened.');
    note(`Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" to write it.`);
    await sql.end({ timeout: 5 });
    return;
  }

  // ── APPLY: one transaction per lot, asserted from inside it ──────────────
  const done = [];
  const failed = [];
  for (const p of plan) {
    const l = byLot.get(p.lotId);
    try {
      const newId = await sql.begin(async (tx) => {
        const pre = await snapshot(tx, l);

        /* Refuse a lot whose numbers moved since the plan. The predicate IS the
           guard: 0 rows back means somebody shipped, returned or costed this
           lot in between, and the plan's arithmetic no longer describes it. */
        const [cons] = await tx`
          SELECT COALESCE(SUM(qty_consumed), 0)::int AS qty, COALESCE(SUM(total_cost_sen), 0)::bigint AS cost
            FROM scm.inventory_lot_consumptions WHERE lot_id = ${p.lotId}`;
        if (Number(cons.qty) !== p.keepQty || Number(cons.cost) !== 0) {
          throw new Error(`consumption ledger moved: ${cons.qty} units / ${cons.cost} sen, planned ${p.keepQty} units / 0 sen`);
        }

        const closed = await tx`
          UPDATE scm.inventory_lots
             SET qty_received = ${p.keepQty}, qty_remaining = 0
           WHERE id = ${p.lotId} AND company_id = ${CO}
             AND qty_received = ${l.qtyReceived} AND qty_remaining = ${l.qtyRemaining}
             AND COALESCE(unit_cost_sen, 0) = 0
          RETURNING id`;
        if (closed.length !== 1) throw new Error('lot moved since the plan was computed — refusing');

        /* The open half is a COPY of the original row, so warehouse, variant,
           product name, batch, source document, movement and — the one that
           decides FIFO — received_at are inherited verbatim rather than
           re-typed. Only the three columns this repair exists to change are
           overridden. */
        const marker = `split from lot ${p.lotId} on ${new Date().toISOString().slice(0, 10)}: ${p.keepQty} unit(s) already shipped at zero cost stay on that lot; these ${p.splitQty} carry the AutoCount purchase cost.`;
        const inserted = await tx`
          INSERT INTO scm.inventory_lots
            (warehouse_id, item_code, product_name, variant_key, qty_received, qty_remaining,
             unit_cost_sen, received_at, source_doc_type, source_doc_id, source_doc_no,
             movement_id, batch_no, notes, created_by, company_id)
          SELECT warehouse_id, item_code, product_name, variant_key,
                 ${p.splitQty}, ${p.splitQty}, ${p.splitUnitCostSen},
                 received_at, source_doc_type, source_doc_id, source_doc_no,
                 movement_id, batch_no,
                 LTRIM(COALESCE(notes, '') || E'\n' || ${marker}, E'\n'),
                 created_by, company_id
            FROM scm.inventory_lots WHERE id = ${p.lotId}
          RETURNING id, received_at`;
        if (inserted.length !== 1) throw new Error('the open half was not inserted — refusing');
        if (String(inserted[0].received_at) !== String(l.receivedAt)) {
          throw new Error('the open half did not inherit received_at — FIFO position would move');
        }

        if (p.movementId) {
          const mov = await tx`
            UPDATE scm.inventory_movements
               SET unit_cost_sen = ${p.splitUnitCostSen}, total_cost_sen = ${p.movementTotalCostSen}
             WHERE id = ${p.movementId} AND company_id = ${CO}
            RETURNING id`;
          if (mov.length !== 1) throw new Error('the receipt movement was not re-valued — refusing');
        }

        const post = await snapshot(tx, l);
        const fails = conservation(pre, post, p.valueDeltaSen);
        if (fails.length) throw new Error(fails.join('; '));

        return inserted[0].id;
      });
      done.push({ ...p, newLotId: newId });
    } catch (e) {
      failed.push({ lotId: p.lotId, itemCode: p.itemCode, message: e.message });
      bad(`${p.itemCode} (${p.lotId}): ${e.message} — this lot rolled back, the run continues`);
    }
  }
  note('');
  note(`applied: ${done.length} lot(s), ${done.reduce((s, p) => s + p.splitQty, 0)} units, ${rm(done.reduce((s, p) => s + p.valueDeltaSen, 0))}`);
  if (failed.length) note(`refused / rolled back: ${failed.length} lot(s)`);

  // ── VERIFY ON A FRESH CONNECTION — assert the VALUES, not the count ──────
  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('');
    note('=== VERIFIED ON A FRESH CONNECTION ===');

    /* Every closed half must now BE `received = what shipped, on hand 0, cost
       0`, and every open half must BE `received = on hand = the split qty, at
       the planned cost, at the original instant`. Selecting the rows that are
       NOT in that shape is the assertion; a count of rows touched would have
       passed even if every cost had landed on the wrong half. */
    const assertShape = async () => {
      /* Both halves are fetched by id and paired in JS against the plan, never
         joined to each other in SQL. A join that matches nothing reports zero
         wrong rows and reads as a pass — the failure mode this repo keeps
         paying for. Here a missing row is itself a violation. */
      const rows = await check`
        SELECT id::text AS id, qty_received, qty_remaining, COALESCE(unit_cost_sen, 0) AS unit_cost_sen,
               received_at
          FROM scm.inventory_lots
         WHERE id = ANY(${[...done.map((p) => p.lotId), ...done.map((p) => p.newLotId)]})`;
      const seen = new Map(rows.map((r) => [String(r.id), r]));
      const wrong = [];
      for (const p of done) {
        const closed = seen.get(String(p.lotId));
        const open = seen.get(String(p.newLotId));
        if (!closed) { wrong.push(`${p.itemCode}: the closed half ${p.lotId} is GONE`); continue; }
        if (!open) { wrong.push(`${p.itemCode}: the open half ${p.newLotId} is GONE`); continue; }
        if (Number(closed.qty_remaining) !== 0 || Number(closed.unit_cost_sen) !== 0 || Number(closed.qty_received) !== p.keepQty) {
          wrong.push(`${p.itemCode}: closed half is received ${closed.qty_received} / on hand ${closed.qty_remaining} @ ${closed.unit_cost_sen}, expected ${p.keepQty} / 0 @ 0`);
        }
        if (Number(open.qty_received) !== p.splitQty || Number(open.qty_remaining) !== p.splitQty || Number(open.unit_cost_sen) !== p.splitUnitCostSen) {
          wrong.push(`${p.itemCode}: open half is received ${open.qty_received} / on hand ${open.qty_remaining} @ ${open.unit_cost_sen}, expected ${p.splitQty} / ${p.splitQty} @ ${p.splitUnitCostSen}`);
        }
        if (String(open.received_at) !== String(closed.received_at)) {
          wrong.push(`${p.itemCode}: the open half sits at ${open.received_at}, the original at ${closed.received_at} — FIFO position MOVED`);
        }
      }
      return wrong;
    };
    const wrongShape = await assertShape();
    if (wrongShape.length) for (const w of wrongShape) bad(`  ${w}`);
    else note(`  all ${done.length} pair(s) read back correctly: the closed half on hand 0 at cost 0, the open half received = on hand at the planned cost, both at the same received_at`);

    const [after] = await check`
      SELECT COALESCE(SUM(qty_remaining::bigint * unit_cost_sen), 0)::bigint AS value_sen,
             COALESCE(SUM(qty_remaining), 0)::bigint AS qty
        FROM scm.inventory_lots WHERE company_id = ${CO}`;
    const movedSen = Number(after.value_sen) - Number(tot.value_sen);
    const expectSen = done.reduce((s, p) => s + p.valueDeltaSen, 0);
    note(`  company ${CO} units on hand: ${tot.qty} -> ${after.qty} (must be identical)`);
    note(`  company ${CO} inventory value moved by ${rm(movedSen)}; the applied plan says ${rm(expectSen)}`);
    if (Number(after.qty) !== Number(tot.qty)) bad(`units on hand moved by ${Number(after.qty) - Number(tot.qty)} — quantity was NOT conserved`);
    if (movedSen !== expectSen) bad(`value moved by ${movedSen} sen, the plan says ${expectSen} sen`);

    const stillZero = await check`
      SELECT COUNT(*)::int AS lots, COALESCE(SUM(qty_remaining), 0)::int AS units
        FROM scm.inventory_lots
       WHERE company_id = ${CO} AND COALESCE(unit_cost_sen, 0) = 0 AND qty_remaining > 0`;
    note(`  still open at zero cost: ${stillZero[0].lots} lot(s) / ${stillZero[0].units} unit(s) — these are the gift / demo / display pieces, whose cost IS zero`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (failed.length) process.exit(1);
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
