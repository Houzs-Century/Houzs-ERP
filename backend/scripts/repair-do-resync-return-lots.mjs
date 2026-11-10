#!/usr/bin/env node
/* Return lots with no origin, minted by shipped-DO edits: make the lots follow the
   stock that really left, and close the lot the edit minted.

   WHAT HAPPENED. Editing a shipped DO line (lower the qty, delete it, or change its
   spec so its units move bucket) gives units back through
   scm.fn_return_do_units_at_cost. That call failed every time until #5589, and the
   route then wrote a plain IN. The FIFO trigger made that IN a NEW lot whose
   source is the DO: no GRN, no PO, while the lot that really paid stayed consumed.
   Found on 2990-DO-2611-016 / -018, CODY-(K), KL WAREHOUSE.

   OWNER DECISION 2026-11-10: "put it back where it really came from". Per such IN
   (rule in lib/do-return-lot-repair.mjs, planActual), in one transaction:
     - if the same edit wrote an OUT in the line's NEW spec that consumed nothing,
       the old consumption is what shipped: it is re-pointed to that OUT (DO-016
       stays shipped from GRN 2611-010 / PO 2610-028, and its uncosted OUT is
       reconciled instead of leaving a phantom unit on the shelf);
     - otherwise the unit really came back: the old consumption is given back to
       its own lot (DO-018: the GRN 2610-028 unit returns; the DO stays shipped from
       GRN 2610-011 / PO 2609-025, which its new-spec OUT consumed);
     - the bucket OUTs are re-costed from the consumptions that remain, the minted
       lot is closed and the IN's cost set to 0, with a marker in its notes.
   Movements are not touched, so on-hand by item does not change; the open lots
   come to equal it.

   LEFT ALONE, and printed: a minted lot another document already drew on (the
   source-PO trace follows it back instead) and a lot already closed (cancelled DO).
   It does NOT need the DO line's shipped_from stamp, and does not write it.

   The plan prints, per IN: the shipped bucket -> the source lot (GRN / PO) -> what
   changes, and per (warehouse, item) touched the open-lot qty before and after
   against the movement qty, per bucket and in total. Quantities only: this repo's
   Actions logs are public, so no cost is ever printed.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="PUT DO UNITS BACK WHERE THEY CAME FROM". Optional COMPANY_ID=<n>.
   Verified on a fresh connection: every repaired IN's lot is closed and its cost 0,
   no DO bucket holds more consumed units than its OUTs, and each touched
   (warehouse, item) is no further from "open lots = movements" than before.

   RE-RUN: inert. Keyed on the exact fallback notes and an open, untouched minted
   lot; a repaired IN carries the marker and a closed lot, so it is never picked again. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { FALLBACK_NOTES, REPAIR_MARK, skipReason, planActual } from './lib/do-return-lot-repair.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const CONFIRM_PHRASE = 'PUT DO UNITS BACK WHERE THEY CAME FROM';
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
         COALESCE(m.variant_key, '') AS vk, m.batch_no, m.qty, m.correction_seq, m.notes, m.created_at,
         l.id AS lot_id, l.qty_received, l.qty_remaining,
         (SELECT COUNT(*)::int FROM scm.inventory_lot_consumptions c WHERE c.lot_id = l.id) AS lot_used
    FROM scm.inventory_movements m
    LEFT JOIN scm.inventory_lots l ON l.movement_id = m.id AND l.company_id = m.company_id
   WHERE m.source_doc_type = 'DO' AND m.movement_type = 'IN' AND m.correction_seq IS NOT NULL
     AND m.notes LIKE 'Resync: line qty reduced / line deleted (shipped DO).%'
     AND (${CO}::bigint IS NULL OR m.company_id = ${CO}::bigint)
   ORDER BY m.created_at, m.id`;

/* The DO's consumptions of the IN's (old) bucket, newest first: the order
   scm.fn_return_do_units_at_cost unwinds in. Company scope comes from the OUT
   movement they hang off: a consumption's own company_id is not reliable (the
   FIFO functions insert it without one, so it takes the column default; the
   first production plan found none under company 2). The locked form is the same
   statement with FOR UPDATE, spelled out rather than spliced. */
const oldConsumptions = (client, r, lock) => (lock
  ? client`
  SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen, c.warehouse_id, c.item_code, c.source_doc_type,
         c.source_doc_id, c.source_doc_no, c.created_by, c.company_id
    FROM scm.inventory_lot_consumptions c
    JOIN scm.inventory_movements mo ON mo.id = c.movement_id
   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
     AND mo.company_id = ${r.company_id}
     AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
     AND COALESCE(mo.variant_key, '') = ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}
   ORDER BY c.consumed_at DESC NULLS LAST, c.id DESC
   FOR UPDATE OF c`
  : client`
  SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen, c.warehouse_id, c.item_code, c.source_doc_type,
         c.source_doc_id, c.source_doc_no, c.created_by, c.company_id
    FROM scm.inventory_lot_consumptions c
    JOIN scm.inventory_movements mo ON mo.id = c.movement_id
   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
     AND mo.company_id = ${r.company_id}
     AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
     AND COALESCE(mo.variant_key, '') = ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}
   ORDER BY c.consumed_at DESC NULLS LAST, c.id DESC`);

/* OUTs the same edit wrote in another bucket: same DO, correction_seq, warehouse,
   item and batch, different variant. `consumed` = units a lot already backs. */
const siblingOuts = (client, r) => client`
  SELECT mo.id, COALESCE(mo.variant_key, '') AS variant_key, ABS(mo.qty)::int AS qty,
         COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = mo.id), 0)::int AS consumed
    FROM scm.inventory_movements mo
   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
     AND mo.company_id = ${r.company_id} AND mo.correction_seq = ${r.correction_seq}
     AND mo.warehouse_id = ${r.warehouse_id} AND mo.item_code = ${r.item_code}
     AND COALESCE(mo.variant_key, '') <> ${r.vk} AND mo.batch_no IS NOT DISTINCT FROM ${r.batch_no}
   ORDER BY mo.id`;

/* Per bucket of one (company, warehouse, item): movement qty (the balance view's
   signs) and open-lot qty. */
const ledgerByBucket = async (client, k) => {
  const mov = await client`
    SELECT COALESCE(variant_key, '') AS vk,
           SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements
     WHERE company_id = ${k.company_id} AND warehouse_id = ${k.warehouse_id} AND item_code = ${k.item_code}
     GROUP BY 1`;
  const lots = await client`
    SELECT COALESCE(variant_key, '') AS vk, SUM(qty_remaining)::int AS qty
      FROM scm.inventory_lots
     WHERE company_id = ${k.company_id} AND warehouse_id = ${k.warehouse_id} AND item_code = ${k.item_code} AND qty_remaining > 0
     GROUP BY 1`;
  const out = new Map();
  for (const m of mov) out.set(m.vk, { mov: Number(m.qty), lots: 0 });
  for (const l of lots) out.set(l.vk, { mov: out.get(l.vk)?.mov ?? 0, lots: Number(l.qty) });
  return out;
};
const gap = (byBucket) => [...byBucket.values()].reduce((s, b) => s + b.lots, 0) - [...byBucket.values()].reduce((s, b) => s + b.mov, 0);

const lotLabels = async (client, ids) => {
  const out = new Map();
  if (ids.length === 0) return out;
  const rows = await client`SELECT id, COALESCE(variant_key, '') AS vk, batch_no, source_doc_type, source_doc_no
                              FROM scm.inventory_lots WHERE id = ANY(${ids}::uuid[])`;
  for (const l of rows) out.set(l.id, { vk: l.vk, text: `lot ${String(l.id).slice(0, 8)} ${l.source_doc_type}:${l.source_doc_no ?? '-'} PO ${l.batch_no ?? '-'}` });
  return out;
};

const short = (id) => String(id).slice(0, 8);
const vkOf = (v) => v || '-';
const label = (r) => `${r.source_doc_no} ${r.item_code} (company ${r.company_id}, IN ${short(r.id)})`;
const keyOf = (r) => `${r.company_id}|${r.warehouse_id}|${r.item_code}`;

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'}${CO ? ` company=${CO}` : ' all companies'}`);
  const rows = await candidates(sql);
  const fix = [];
  const skip = [];
  for (const r of rows) {
    const why = skipReason(r);
    if (why) { skip.push({ r, why }); continue; }
    const cons = await oldConsumptions(sql, r, false);
    const outs = await siblingOuts(sql, r);
    fix.push({ r, cons, outs, plan: planActual(cons, outs, Number(r.qty)) });
  }

  note(`\n=== FALLBACK RETURN INs: ${rows.length} (notes "${FALLBACK_NOTES}") ===`);
  const labels = await lotLabels(sql, [...new Set(fix.flatMap((f) => f.cons.map((c) => c.lot_id)))]);
  for (const { r, outs, plan } of fix) {
    note(`  REPAIR ${label(r)}`);
    note(`    shipped bucket [${vkOf(r.vk)}] x${r.qty}; the same edit's OUT(s) in the new spec: ${outs.map((o) => `[${vkOf(o.variant_key)}] x${o.qty}, lot-backed ${o.consumed}`).join('; ') || 'none'}`);
    for (const m of plan.move) note(`    STAYS SHIPPED  ${labels.get(m.lot_id)?.text ?? short(m.lot_id)} x${m.take} -> re-pointed to the new-spec OUT ${short(m.to_out)} [${vkOf(m.to_vk)}]`);
    for (const s of plan.restore) note(`    BACK ON SHELF  ${labels.get(s.lot_id)?.text ?? short(s.lot_id)} +${s.take}`);
    if (plan.uncosted) note(`    ${plan.uncosted} unit(s) had no consumption behind them: nothing to move or give back`);
    note(`    CLOSE          lot ${short(r.lot_id)} (source ${r.source_doc_no}, no GRN, no PO) -${r.qty_remaining}`);
  }
  for (const { r, why } of skip) note(`  SKIP   ${label(r)} [${vkOf(r.vk)}] x${r.qty}: ${why}`);
  note(`\n  to repair: ${fix.length}   skipped: ${skip.length}`);

  /* Before / after per touched (warehouse, item). After = before with the plan's
     lot changes; movements do not change. */
  const touched = new Map();
  for (const f of fix) touched.set(keyOf(f.r), f.r);
  const before = new Map();
  for (const [k, r] of touched) {
    const led = await ledgerByBucket(sql, r);
    before.set(k, led);
    const after = new Map([...led].map(([vk, b]) => [vk, { ...b }]));
    const bump = (vk, n) => { const b = after.get(vk) ?? { mov: 0, lots: 0 }; b.lots += n; after.set(vk, b); };
    for (const f of fix.filter((x) => keyOf(x.r) === k)) {
      bump(f.r.vk, -Number(f.r.qty_remaining));
      for (const s of f.plan.restore) bump(labels.get(s.lot_id)?.vk ?? f.r.vk, s.take);
    }
    note(`\n=== ${r.item_code} at warehouse ${short(r.warehouse_id)} (company ${r.company_id}): open lots vs movements ===`);
    for (const [vk, b] of after) {
      const was = led.get(vk) ?? { mov: 0, lots: 0 };
      note(`  [${vkOf(vk)}] movements ${b.mov} | open lots ${was.lots} -> ${b.lots}${b.lots === b.mov ? '' : ' (differs)'}`);
    }
    note(`  TOTAL movements ${[...after.values()].reduce((s, b) => s + b.mov, 0)} | open lots ${[...led.values()].reduce((s, b) => s + b.lots, 0)} -> ${[...after.values()].reduce((s, b) => s + b.lots, 0)}`);
  }

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
        const cons = await oldConsumptions(tx, r, true);
        const outs = await siblingOuts(tx, r);
        const plan = planActual(cons, outs, Number(r.qty));
        const byId = new Map(cons.map((c) => [c.id, c]));
        const taken = new Map();
        for (const m of plan.move) {
          const c = byId.get(m.id);
          await tx`INSERT INTO scm.inventory_lot_consumptions
                     (lot_id, warehouse_id, item_code, variant_key, qty_consumed, unit_cost_sen, total_cost_sen,
                      consumed_at, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, company_id)
                   VALUES (${c.lot_id}, ${c.warehouse_id}, ${c.item_code}, ${m.to_vk}, ${m.take}, ${c.unit_cost_sen},
                           ${m.take * Number(c.unit_cost_sen ?? 0)}, now(), ${c.source_doc_type}, ${c.source_doc_id},
                           ${c.source_doc_no}, ${m.to_out}, ${c.created_by}, ${c.company_id})`;
          taken.set(m.id, (taken.get(m.id) ?? 0) + m.take);
        }
        for (const s of plan.restore) {
          await tx`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining + ${s.take}
                    WHERE id = ${s.lot_id} AND company_id = ${r.company_id}`;
          taken.set(s.id, (taken.get(s.id) ?? 0) + s.take);
        }
        for (const [id, n] of taken) {
          const c = byId.get(id);
          const left = Number(c.qty_consumed) - n;
          if (left <= 0) await tx`DELETE FROM scm.inventory_lot_consumptions WHERE id = ${id}`;
          else await tx`UPDATE scm.inventory_lot_consumptions SET qty_consumed = ${left}, total_cost_sen = ${left * Number(c.unit_cost_sen ?? 0)}
                          WHERE id = ${id}`;
        }
        /* Re-cost every OUT of this item on this DO from the consumptions it now has. */
        await tx`
          UPDATE scm.inventory_movements m
             SET total_cost_sen = sub.total_cost,
                 unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
            FROM (SELECT mo.id, COALESCE((SELECT SUM(c.total_cost_sen) FROM scm.inventory_lot_consumptions c
                                           WHERE c.movement_id = mo.id), 0) AS total_cost
                    FROM scm.inventory_movements mo
                   WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
                     AND mo.company_id = ${r.company_id} AND mo.warehouse_id = ${r.warehouse_id}
                     AND mo.item_code = ${r.item_code}) sub
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
      const [mov] = await check`SELECT total_cost_sen, notes FROM scm.inventory_movements WHERE id = ${r.id}`;
      const over = await check`
        SELECT mo.id FROM scm.inventory_movements mo
         WHERE mo.source_doc_type = 'DO' AND mo.source_doc_id = ${r.source_doc_id} AND mo.movement_type = 'OUT'
           AND mo.company_id = ${r.company_id} AND mo.item_code = ${r.item_code}
           AND COALESCE((SELECT SUM(c.qty_consumed) FROM scm.inventory_lot_consumptions c WHERE c.movement_id = mo.id), 0) > ABS(mo.qty)`;
      const ok = Number(lot?.qty_remaining) === 0 && Number(mov?.total_cost_sen) === 0
        && String(mov?.notes ?? '').endsWith(REPAIR_MARK) && over.length === 0;
      if (!ok) wrong += 1;
      (ok ? note : bad)(`  ${ok ? 'OK ' : 'BAD'} ${label(r)}: minted lot left ${lot?.qty_remaining}, IN cost zeroed ${Number(mov?.total_cost_sen) === 0 ? 'yes' : 'NO'}, OUTs over-consumed ${over.length}`);
    }
    for (const [k, r] of touched) {
      if (!done.some((d) => keyOf(d) === k)) continue;
      const g0 = gap(before.get(k));
      const g1 = gap(await ledgerByBucket(check, r));
      const ok = Math.abs(g1) <= Math.abs(g0);
      if (!ok) wrong += 1;
      (ok ? note : bad)(`  ${ok ? 'OK ' : 'BAD'} ${r.item_code} at ${short(r.warehouse_id)}: open lots minus movements ${g0} -> ${g1}`);
    }
    note(`  ${done.length} IN(s) repaired; ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
