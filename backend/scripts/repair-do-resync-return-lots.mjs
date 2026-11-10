#!/usr/bin/env node
/* Return lots with no origin, minted by shipped-DO edits: put the units back on
   the lots that paid for them, and close the lot the edit minted.

   WHAT HAPPENED. Editing a shipped DO line (lower the qty, delete it, or change its
   spec so its units move bucket) gives units back through
   scm.fn_return_do_units_at_cost. That call failed every time until 2026-11-10
   (wrong parameter name since #2447, and a column the function body named that
   does not exist), and the route then wrote a plain IN. The FIFO trigger made that
   IN a NEW lot whose source is the DO: no GRN, no PO, at a blended cost, while
   the lot that really paid stayed consumed. Found on 2990-DO-2611-016 / -018,
   CODY-(K), KL WAREHOUSE (the source-PO planner saw a rack but no PO).

   THE REPAIR, per such IN (lib/do-return-lot-repair.mjs), in one transaction:
     1. unwind the DO's consumptions of the same bucket (warehouse, item, variant,
        batch) newest-first up to the IN's qty, giving each unit back to its own lot
        (delete a wholly returned consumption, shrink a partial one);
     2. re-stamp the bucket's OUT costs from the consumptions that remain;
     3. close the lot the IN minted (only while still untouched) and set the IN's
        cost to 0, with a marker in its notes.
   The same three steps scm.fn_return_do_units_at_cost runs today. Counts do not
   change: the units move from the minted lot back to their original lot.

   LEFT ALONE, and printed: a minted lot another document already drew on (the
   source-PO trace follows it back to its origin instead), a lot already closed
   (cancelled DO), and an IN whose DO line for that item is not stamped yet. The
   DO's old consumption is the only record of the PO until the stamp locks it, so
   run stamp-do-shipped-from.mjs (apply) first, then this.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="RETURN DO UNITS TO THEIR LOTS". Optional COMPANY_ID=<n> limits the run.
   Verified on a fresh connection: every repaired IN's lot is closed, its cost is 0,
   and its DO bucket holds no more consumed units than it net-shipped.

   RE-RUN: inert. Keyed on the exact fallback notes and an open, untouched minted
   lot; a repaired IN carries the marker and a closed lot, so it is never picked again. */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { FALLBACK_NOTES, REPAIR_MARK, skipReason, unwindPlan } from './lib/do-return-lot-repair.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const CONFIRM_PHRASE = 'RETURN DO UNITS TO THEIR LOTS';
const CO = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;
if (CO !== null && !(Number.isInteger(CO) && CO > 0)) { console.error('COMPANY_ID must be a positive integer'); process.exit(2); }

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const candidates = (client) => client`
  SELECT m.id, m.company_id, m.source_doc_id, m.source_doc_no, m.warehouse_id, m.item_code,
         COALESCE(m.variant_key, '') AS vk, m.batch_no, m.qty, m.unit_cost_sen, m.notes, m.created_at,
         l.id AS lot_id, l.qty_received, l.qty_remaining,
         (SELECT COUNT(*)::int FROM scm.inventory_lot_consumptions c WHERE c.lot_id = l.id) AS lot_used,
         (SELECT COUNT(*)::int FROM scm.delivery_order_items i
           WHERE i.delivery_order_id = m.source_doc_id AND i.company_id = m.company_id
             AND i.item_code = m.item_code AND i.shipped_from IS NULL) AS unstamped_lines
    FROM scm.inventory_movements m
    LEFT JOIN scm.inventory_lots l ON l.movement_id = m.id AND l.company_id = m.company_id
   WHERE m.source_doc_type = 'DO' AND m.movement_type = 'IN' AND m.correction_seq IS NOT NULL
     AND m.notes LIKE 'Resync: line qty reduced / line deleted (shipped DO).%'
     AND (${CO}::bigint IS NULL OR m.company_id = ${CO}::bigint)
   ORDER BY m.created_at, m.id`;

/* Newest first, the order scm.fn_return_do_units_at_cost unwinds in. The locked
   form is the same statement with FOR UPDATE, spelled out rather than spliced. */
const bucketConsumptions = (client, r, lock) => (lock
  ? client`
  SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen
    FROM scm.inventory_lot_consumptions c
    JOIN scm.inventory_movements mo ON mo.id = c.movement_id
   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
     AND mo.company_id = ${r.company_id} AND c.company_id = ${r.company_id}
     AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
     AND COALESCE(mo.variant_key, '') = ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}
   ORDER BY c.consumed_at DESC NULLS LAST, c.id DESC
   FOR UPDATE OF c`
  : client`
  SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen
    FROM scm.inventory_lot_consumptions c
    JOIN scm.inventory_movements mo ON mo.id = c.movement_id
   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
     AND mo.company_id = ${r.company_id} AND c.company_id = ${r.company_id}
     AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
     AND COALESCE(mo.variant_key, '') = ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}
   ORDER BY c.consumed_at DESC NULLS LAST, c.id DESC`);

const bucketNetOut = async (client, r) => {
  const [x] = await client`
    SELECT COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN qty WHEN movement_type = 'IN' THEN -qty ELSE 0 END), 0)::int AS net
      FROM scm.inventory_movements
     WHERE source_doc_type = 'DO' AND source_doc_id = ${r.source_doc_id} AND company_id = ${r.company_id}
       AND warehouse_id = ${r.warehouse_id} AND item_code = ${r.item_code}
       AND COALESCE(variant_key, '') = ${r.vk} AND batch_no IS NOT DISTINCT FROM ${r.batch_no}`;
  return Number(x.net);
};

const label = (r) => `${r.source_doc_no} ${r.item_code} [${r.vk || '-'}]${r.batch_no ? ` batch ${r.batch_no}` : ''} x${r.qty} (company ${r.company_id}, IN ${String(r.id).slice(0, 8)})`;

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}${CO ? ` company=${CO}` : ' all companies'}`);
  const rows = await candidates(sql);
  const fix = [];
  const skip = [];
  for (const r of rows) {
    const why = skipReason(r);
    if (why) { skip.push({ r, why }); continue; }
    const plan = unwindPlan(await bucketConsumptions(sql, r, false), Number(r.qty));
    fix.push({ r, plan });
  }
  note(`\n=== FALLBACK RETURN INs: ${rows.length} (fallback notes "${FALLBACK_NOTES}") ===`);
  for (const { r, plan } of fix) {
    note(`  REPAIR ${label(r)}: close lot ${String(r.lot_id).slice(0, 8)} (left ${r.qty_remaining}, cost ${r.unit_cost_sen}); `
      + `give ${plan.restored} unit(s) back to ${plan.steps.map((s) => `${String(s.lot_id).slice(0, 8)}+${s.take}`).join(', ') || 'no lot'}`
      + (plan.uncosted ? `; ${plan.uncosted} unit(s) had no consumption (shipped uncosted), nothing to give back` : ''));
  }
  for (const { r, why } of skip) note(`  SKIP   ${label(r)}: ${why}`);
  note(`\n  to repair: ${fix.length}   skipped: ${skip.length}`);

  if (!APPLY || fix.length === 0) {
    note(APPLY ? '\nNothing to repair.' : `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== REPAIRING ${fix.length} IN(s) ===`);
  const done = [];
  for (const { r } of fix) {
    try {
      await sql.begin(async (tx) => {
        /* Re-read under lock: the plan above is a preview, this is the answer. */
        const [lot] = await tx`SELECT qty_received, qty_remaining FROM scm.inventory_lots
                                WHERE id = ${r.lot_id} AND company_id = ${r.company_id} FOR UPDATE`;
        const [used] = await tx`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE lot_id = ${r.lot_id}`;
        if (!lot || Number(lot.qty_remaining) <= 0 || Number(lot.qty_remaining) !== Number(lot.qty_received) || used.n > 0) {
          throw new Error('minted lot changed since the plan');
        }
        const plan = unwindPlan(await bucketConsumptions(tx, r, true), Number(r.qty));
        for (const s of plan.steps) {
          await tx`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining + ${s.take}
                    WHERE id = ${s.lot_id} AND company_id = ${r.company_id}`;
          if (s.remove) await tx`DELETE FROM scm.inventory_lot_consumptions WHERE id = ${s.id} AND company_id = ${r.company_id}`;
          else await tx`UPDATE scm.inventory_lot_consumptions SET qty_consumed = ${s.left}, total_cost_sen = ${s.left * s.unit_cost_sen}
                          WHERE id = ${s.id} AND company_id = ${r.company_id}`;
        }
        await tx`
          UPDATE scm.inventory_movements m
             SET total_cost_sen = sub.total_cost,
                 unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
            FROM (SELECT mo.id, COALESCE((SELECT SUM(c.total_cost_sen) FROM scm.inventory_lot_consumptions c
                                           WHERE c.movement_id = mo.id), 0) AS total_cost
                    FROM scm.inventory_movements mo
                   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
                     AND mo.company_id = ${r.company_id} AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
                     AND COALESCE(mo.variant_key, '') = ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}) sub
           WHERE m.id = sub.id`;
        await tx`UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE id = ${r.lot_id} AND company_id = ${r.company_id}`;
        await tx`UPDATE scm.inventory_movements SET unit_cost_sen = 0, total_cost_sen = 0, notes = notes || ${REPAIR_MARK}
                  WHERE id = ${r.id} AND company_id = ${r.company_id} AND notes = ${FALLBACK_NOTES}`;
      });
      done.push(r);
      note(`  OK   ${label(r)}`);
    } catch (e) {
      bad(`  FAIL ${label(r)}: ${e.message} (rolled back)`);
    }
  }
  note(`  repaired: ${done.length} of ${fix.length}`);
  await sql.end({ timeout: 5 });

  /* Fresh connection: check the SHAPE each repair left, not the count it reported. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    let wrong = 0;
    for (const r of done) {
      const [lot] = await check`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${r.lot_id}`;
      const [mov] = await check`SELECT unit_cost_sen, total_cost_sen, notes FROM scm.inventory_movements WHERE id = ${r.id}`;
      const consumed = (await bucketConsumptions(check, r, false)).reduce((s, c) => s + Number(c.qty_consumed), 0);
      const net = await bucketNetOut(check, r);
      const ok = Number(lot?.qty_remaining) === 0 && Number(mov?.unit_cost_sen) === 0 && Number(mov?.total_cost_sen) === 0
        && String(mov?.notes ?? '').endsWith(REPAIR_MARK) && consumed <= Math.max(0, net);
      if (!ok) wrong += 1;
      (ok ? note : bad)(`  ${ok ? 'OK ' : 'BAD'} ${label(r)}: minted lot left ${lot?.qty_remaining}, IN cost ${mov?.unit_cost_sen}/${mov?.total_cost_sen}, bucket consumed ${consumed} vs net shipped ${net}`);
    }
    note(`  ${done.length - wrong} of ${done.length} verified`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
