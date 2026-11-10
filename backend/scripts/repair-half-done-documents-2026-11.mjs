#!/usr/bin/env node
/* Write the stock movements four half-done documents are missing (or have too
   many of), so each document's movements match its posted lines and the FIFO
   lots match the movements.

   FOUND by check-half-done-documents.mjs, run 42808054032, company 1 (Houzs).
   INVESTIGATED read-only (runs 42824682129, 42825512713): four separate
   stories, two warehouses, different specs and SO / PO chains, so none cancels
   another out. The story per document and the rule per kind are in
   lib/half-done-repair-2026-11.mjs:
     HC-GRN-2609-118  8030-2A(LHF): IN never written; DO-2610-329 shipped it uncosted.
                      Writes IN +1 (GRN line cost); DO-329's OUT draws that lot.
     HC-GRN-2610-045  8030-1A(LHF), 8030-2A(RHF): re-post after cancel wrote no IN; a
                      lot with no movement stood in and DO-2610-343 shipped from it.
                      Writes IN +1 each; the lot each IN opens is closed at once.
     HC-DO-2610-319   Confirmed with no OUT: 8030-1A(LHF), 8030-CONSOLE, 8030-1A(RHF),
                      AMN-SOFA PILLOW x2. Writes the OUTs the ship would have written;
                      they consume the GRN-2610-030 lots and 2 pillows.
     HC-DO-2610-419   cancelled, ELEPHANE-(K) given back twice. DO-2610-420's uncosted
                      OUT draws the GRN-2610-207 lot; ADJUSTMENT -1 against the cancel.

   Every kind must leave its bucket at movements == open lots. Anything else is
   refused, and on apply ONE refusal writes nothing at all: the four documents go
   in one transaction, all or none. A document whose movements already match its
   lines is reported "already done" and skipped (that is what makes a re-run inert).

   The plan prints, per document: the finding, the explanation, the movements to
   write (document numbers, item codes, qty) and the lot links, and the bucket
   before / after. Quantities only: this repo's Actions logs are public, so no
   cost, customer or phone is ever printed.

   MODE=plan (default) writes nothing. MODE=apply needs
   CONFIRM="WRITE THE MISSING HALF-DONE MOVEMENTS". Optional COMPANY_ID (default 1).
   Verified on a fresh connection: each document's movements match its lines by
   the same rule the check uses (compareDocItems / cancelledResidue), every touched
   bucket has movements == open lots, each opened-and-closed lot is closed, no OUT
   draws more than its qty, and every written row carries the tag in its notes.
   Also asks the allocation worker to recompute.

   RE-RUN: inert. After an apply every document's movements match its lines, so each
   one is "already done" and nothing is written twice. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { variantKeyMirror, isServiceLineMirror } from './lib/ledger-repair-core.mjs';
import { DO_STOCK_OUT_STATES } from './lib/do-shipped-states.mjs';
import { compareDocItems, cancelledResidue } from './lib/half-done-documents.mjs';
import {
  CONFIRM_PHRASE, TAG, KIND, TARGETS, EXPLAIN,
  planGrnInMissingShipUncosted, planGrnInLostOnRepost, planDoOutMissing, planCancelledDoOverReversed,
  grnUnitCost, movementNotes,
} from './lib/half-done-repair-2026-11.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
if (!(Number.isInteger(CO) && CO > 0)) { bad('COMPANY_ID must be a positive integer'); process.exit(2); }

const short = (id) => String(id ?? '').slice(0, 8);
const vkOf = (v) => v || '-';
/* A date column as YYYY-MM-DD (the driver hands back a Date at UTC midnight). */
const ymd = (d) => (d == null ? '-' : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/* ---------------------------------------------------------------- reads */

async function bucket(c, wh, item, vk) {
  const [m] = await c`
    SELECT COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END), 0)::int AS mov
      FROM scm.inventory_movements
     WHERE company_id = ${CO} AND warehouse_id = ${wh} AND item_code = ${item} AND COALESCE(variant_key, '') = ${vk}`;
  const [l] = await c`
    SELECT COALESCE(SUM(qty_remaining), 0)::int AS lots FROM scm.inventory_lots
     WHERE company_id = ${CO} AND warehouse_id = ${wh} AND item_code = ${item} AND COALESCE(variant_key, '') = ${vk} AND qty_remaining > 0`;
  return { mov: Number(m.mov), lots: Number(l.lots) };
}

/* The OUT a DO wrote in one bucket, with the units a lot already backs. */
async function doOut(c, doNo, wh, item, vk) {
  const rows = await c`
    SELECT m.id, ABS(m.qty)::int AS qty, m.source_doc_id,
           COALESCE((SELECT SUM(x.qty_consumed) FROM scm.inventory_lot_consumptions x WHERE x.movement_id = m.id), 0)::int AS consumed
      FROM scm.inventory_movements m
     WHERE m.company_id = ${CO} AND m.source_doc_type = 'DO' AND m.movement_type = 'OUT' AND m.source_doc_no = ${doNo}
       AND m.warehouse_id = ${wh} AND m.item_code = ${item} AND COALESCE(m.variant_key, '') = ${vk}
     ORDER BY m.created_at, m.id`;
  if (rows.length !== 1) return null;
  return { outId: rows[0].id, outQty: rows[0].qty, consumed: rows[0].consumed, doId: rows[0].source_doc_id };
}

async function grnFacts(c, t) {
  const [g] = await c`SELECT id, grn_number, status::text AS status, warehouse_id, exchange_rate, received_at
                        FROM scm.grns WHERE company_id = ${CO} AND grn_number = ${t.docNo}`;
  if (!g) return { t, missing: true };
  const lines = await c`
    SELECT gi.id, gi.item_code, gi.item_group, gi.variants, gi.qty_accepted, gi.unit_price_sen, gi.allocated_charge_sen,
           po.po_number
      FROM scm.grn_items gi
      LEFT JOIN scm.purchase_order_items pi ON pi.id = gi.purchase_order_item_id
      LEFT JOIN scm.purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${CO}
     WHERE gi.grn_id = ${g.id} ORDER BY gi.created_at, gi.id`;
  const movs = await c`
    SELECT item_code, COALESCE(variant_key, '') AS vk, movement_type, qty, unit_cost_sen
      FROM scm.inventory_movements
     WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id = ${g.id}`;
  const items = [];
  for (const code of t.items) {
    const l = lines.find((x) => x.item_code === code);
    if (!l) { items.push({ code, missingLine: true }); continue; }
    const vk = variantKeyMirror(l.item_group, l.variants);
    const mine = movs.filter((m) => m.item_code === code);
    const grnNetIn = mine.reduce((s, m) => s + (m.movement_type === 'IN' ? Number(m.qty) : m.movement_type === 'OUT' ? -Number(m.qty) : 0), 0);
    const movVks = [...new Set(mine.map((m) => m.vk))];
    const b = await bucket(c, g.warehouse_id, code, vk);
    const downstream = await doOut(c, t.downstreamDo, g.warehouse_id, code, vk);
    const base = { code, line: l, vk, movVks, grnNetIn, batchNo: l.po_number ?? null, bucket: b, downstream };
    if (t.kind === KIND.GRN_IN_MISSING_SHIP_UNCOSTED) {
      const unitCost = grnUnitCost({ unitPriceSen: l.unit_price_sen, exchangeRate: g.exchange_rate, allocatedChargeSen: l.allocated_charge_sen, qtyAccepted: l.qty_accepted });
      /* The same formula against the GRN's other lines that DID get an IN: yes / no, never the figure. */
      const siblings = lines.filter((x) => x.item_code !== code).map((x) => {
        const ins = movs.filter((m) => m.item_code === x.item_code && m.movement_type === 'IN');
        if (ins.length === 0) return null;
        const landed = grnUnitCost({ unitPriceSen: x.unit_price_sen, exchangeRate: g.exchange_rate, allocatedChargeSen: x.allocated_charge_sen, qtyAccepted: x.qty_accepted });
        const priceOnly = grnUnitCost({ unitPriceSen: x.unit_price_sen, exchangeRate: g.exchange_rate, allocatedChargeSen: 0, qtyAccepted: x.qty_accepted });
        const is = (v) => ins.every((m) => Number(m.unit_cost_sen) === v);
        /* A line ADDED to a posted GRN gets price only (grns.ts line-add); a line posted with the GRN gets the landed cost. */
        return { code: x.item_code, matches: is(landed) ? 'landed (price + charge)' : is(priceOnly) ? 'price only (line added after post)' : 'neither' };
      }).filter(Boolean);
      const hasCharge = Number(l.allocated_charge_sen ?? 0) > 0;
      items.push({ ...base, unitCost, siblings, hasCharge, plan: planGrnInMissingShipUncosted({ lineQty: Number(l.qty_accepted), grnNetIn, bucket: b, unitCost, downstream }) });
    } else {
      const lots = await c`
        SELECT l.id, l.qty_received, l.qty_remaining, l.unit_cost_sen, l.movement_id, l.source_doc_type, l.received_at,
               EXISTS (SELECT 1 FROM scm.inventory_movements m WHERE m.id = l.movement_id) AS has_movement,
               COALESCE((SELECT array_agg(DISTINCT x.source_doc_no) FROM scm.inventory_lot_consumptions x WHERE x.lot_id = l.id), '{}') AS consumed_by
          FROM scm.inventory_lots l
         WHERE l.company_id = ${CO} AND l.warehouse_id = ${g.warehouse_id} AND l.item_code = ${code}
           AND COALESCE(l.variant_key, '') = ${vk} AND l.batch_no IS NOT DISTINCT FROM ${l.po_number ?? null}
           AND l.source_doc_type = 'ADJUSTMENT'
         ORDER BY l.received_at`;
      const pick = lots.find((x) => (x.consumed_by ?? []).includes(t.downstreamDo)) ?? null;
      const standIn = pick ? {
        id: pick.id, qtyReceived: Number(pick.qty_received), qtyRemaining: Number(pick.qty_remaining), unitCost: Number(pick.unit_cost_sen ?? 0),
        hasMovement: Boolean(pick.has_movement), consumedBy: pick.consumed_by ?? [], receivedAt: pick.received_at,
      } : null;
      items.push({ ...base, standIn, plan: planGrnInLostOnRepost({ lineQty: Number(l.qty_accepted), grnNetIn, bucket: b, standIn, downstreamDo: t.downstreamDo }) });
    }
  }
  return { t, g, items };
}

async function doMissingOutFacts(c, t) {
  const [d] = await c`SELECT id, do_number, status::text AS status, warehouse_id, is_dropship, migrated_no_stock
                        FROM scm.delivery_orders WHERE company_id = ${CO} AND do_number = ${t.docNo}`;
  if (!d) return { t, missing: true };
  const [ex] = await c`SELECT COUNT(*)::int AS n FROM scm.inventory_movements
                        WHERE company_id = ${CO} AND source_doc_type = 'DO' AND source_doc_id = ${d.id} AND movement_type = 'OUT'`;
  const [dw] = await c`SELECT id FROM scm.warehouses WHERE company_id = ${CO} AND is_default = true ORDER BY code LIMIT 1`;
  const raw = await c`
    SELECT i.id, i.item_code, i.item_group, i.variants, i.qty, i.committed_po_batch_no,
           si.warehouse_id AS so_wh, si.allocated_batch_no, si.doc_no AS so_doc_no
      FROM scm.delivery_order_items i
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id AND si.company_id = ${CO}
     WHERE i.delivery_order_id = ${d.id} ORDER BY i.line_no, i.id`;
  /* resolveDoLineWarehouses and resolveDoSofaBatchMap, read for read: SO line
     warehouse, else the DO header, else the company default; allocator batch,
     else the stored commitment. A drop-ship DO is refused below (that third
     batch source is not mirrored here). */
  const lines = raw.map((r) => ({
    itemCode: r.item_code, qty: Number(r.qty), soDocNo: r.so_doc_no,
    warehouseId: r.so_wh ?? d.warehouse_id ?? dw?.id ?? null,
    vk: variantKeyMirror(r.item_group, r.variants),
    batchNo: r.allocated_batch_no ?? r.committed_po_batch_no ?? null,
    service: isServiceLineMirror({ itemGroup: r.item_group, itemCode: r.item_code }),
  }));
  const buckets = new Map();
  for (const l of lines) {
    if (!l.warehouseId) continue;
    const k = `${l.warehouseId}::${l.itemCode}::${l.vk}`;
    if (!buckets.has(k)) buckets.set(k, await bucket(c, l.warehouseId, l.itemCode, l.vk));
  }
  const plan = planDoOutMissing({ status: d.status, stockOutStates: DO_STOCK_OUT_STATES, existingOuts: ex.n, lines, buckets });
  if (d.is_dropship === true && !plan.done) plan.refusals.push('a drop-ship DO: its batch rule is not mirrored here');
  if (d.migrated_no_stock === true && !plan.done) plan.refusals.push('a migrated DO: it never moves stock');
  if (plan.refusals.length) plan.outs = [];
  /* The lots each OUT will draw, FIFO in its batch first (what the trigger does): for the plan only. */
  const draws = [];
  for (const o of plan.outs) {
    const lots = await c`
      SELECT id, source_doc_no, batch_no, qty_remaining FROM scm.inventory_lots
       WHERE company_id = ${CO} AND warehouse_id = ${o.warehouseId} AND item_code = ${o.itemCode}
         AND COALESCE(variant_key, '') = ${o.vk} AND qty_remaining > 0
       ORDER BY (batch_no IS NOT DISTINCT FROM ${o.batchNo}) DESC, received_at, id`;
    let need = o.qty;
    for (const l of lots) {
      if (need <= 0) break;
      const n = Math.min(need, Number(l.qty_remaining));
      draws.push({ itemCode: o.itemCode, lot: short(l.id), from: l.source_doc_no, batch: l.batch_no, qty: n });
      need -= n;
    }
  }
  return { t, d, lines, plan, draws };
}

async function cancelledFacts(c, t) {
  const [d] = await c`SELECT id, do_number, status::text AS status FROM scm.delivery_orders WHERE company_id = ${CO} AND do_number = ${t.docNo}`;
  if (!d) return { t, missing: true };
  const items = [];
  for (const code of t.items) {
    const rows = await c`
      SELECT warehouse_id, COALESCE(variant_key, '') AS vk,
             SUM(CASE WHEN source_doc_type = 'DO' AND movement_type = 'OUT' THEN qty
                      WHEN source_doc_type = 'DO' AND movement_type = 'IN' THEN -qty
                      WHEN source_doc_type = 'ADJUSTMENT' AND movement_type = 'ADJUSTMENT' THEN -qty ELSE 0 END)::int AS net,
             (ARRAY_AGG(batch_no ORDER BY created_at) FILTER (WHERE source_doc_type = 'ADJUSTMENT'))[1] AS cancel_batch
        FROM scm.inventory_movements
       WHERE company_id = ${CO} AND source_doc_id = ${d.id} AND item_code = ${code} AND source_doc_type IN ('DO', 'ADJUSTMENT')
       GROUP BY 1, 2`;
    const off = rows.filter((r) => Number(r.net) !== 0);
    if (off.length === 0) { items.push({ code, plan: { done: true, refusals: [], writes: [], attach: [] }, rows }); continue; }
    for (const r of off) {
      const b = await bucket(c, r.warehouse_id, code, r.vk);
      const downstream = await doOut(c, t.downstreamDo, r.warehouse_id, code, r.vk);
      const open = await c`
        SELECT id, source_doc_no, batch_no, qty_remaining FROM scm.inventory_lots
         WHERE company_id = ${CO} AND warehouse_id = ${r.warehouse_id} AND item_code = ${code}
           AND COALESCE(variant_key, '') = ${r.vk} AND qty_remaining > 0 ORDER BY received_at, id`;
      const plan = planCancelledDoOverReversed({
        status: d.status, doNet: Number(r.net), bucket: b, downstream,
        openLots: open.map((l) => ({ id: l.id, qtyRemaining: Number(l.qty_remaining) })),
      });
      items.push({ code, wh: r.warehouse_id, vk: r.vk, net: Number(r.net), cancelBatch: r.cancel_batch, bucket: b, downstream, open, plan });
    }
  }
  return { t, d, items };
}

async function gather(c) {
  const out = [];
  for (const t of TARGETS) {
    if (t.kind === KIND.GRN_IN_MISSING_SHIP_UNCOSTED || t.kind === KIND.GRN_IN_LOST_ON_REPOST) out.push(await grnFacts(c, t));
    else if (t.kind === KIND.DO_OUT_MISSING) out.push(await doMissingOutFacts(c, t));
    else out.push(await cancelledFacts(c, t));
  }
  return out;
}

/** Every refusal across the four documents, labelled. */
function refusalsOf(facts) {
  const out = [];
  for (const f of facts) {
    if (f.missing) { out.push(`${f.t.docNo}: not found in company ${CO}`); continue; }
    if (f.t.kind === KIND.DO_OUT_MISSING) { for (const r of f.plan.refusals) out.push(`${f.t.docNo}: ${r}`); continue; }
    for (const it of f.items) {
      if (it.missingLine) { out.push(`${f.t.docNo} ${it.code}: no such line`); continue; }
      if (it.movVks && it.movVks.some((v) => v !== it.vk)) out.push(`${f.t.docNo} ${it.code}: the GRN's movements carry another spec than the line`);
      for (const r of it.plan.refusals) out.push(`${f.t.docNo} ${it.code}: ${r}`);
    }
  }
  return out;
}

/** A comparable fingerprint of what would be written, to prove the plan did not move under the lock. */
function planShape(facts) {
  return JSON.stringify(facts.map((f) => (f.missing ? null : f.t.kind === KIND.DO_OUT_MISSING
    ? { doc: f.t.docNo, done: f.plan.done, outs: f.plan.outs.map((o) => [o.itemCode, o.vk, o.batchNo, o.qty]) }
    : { doc: f.t.docNo, items: f.items.map((i) => [i.code, i.plan.done, (i.plan.writes ?? []).map((w) => [w.type, w.qty]), (i.plan.attach ?? []).map((a) => a.qty)]) })));
}

/* ---------------------------------------------------------------- print */

function printPlan(facts, whName) {
  for (const f of facts) {
    note(`\n=== ${f.t.docNo} [${f.t.kind}] ===`);
    if (f.missing) { bad('  not found'); continue; }
    note(`  WHY: ${EXPLAIN[f.t.kind]}`);
    if (f.t.kind === KIND.DO_OUT_MISSING) {
      note(`  FINDING: status ${f.d.status}, ${f.lines.length} line(s), stock OUT rows ${f.plan.done ? 'present' : '0'}`);
      for (const l of f.lines) note(`    line ${l.itemCode} x${l.qty} SO ${l.soDocNo ?? '-'} ship-from ${whName(l.warehouseId)} spec [${vkOf(l.vk)}] batch ${l.batchNo ?? '-'}${l.service ? ' (service: no stock)' : ''}`);
      if (f.plan.done) { note('  ALREADY DONE: the DO has its OUT rows. Nothing to write.'); continue; }
      for (const o of f.plan.outs) note(`  WRITE OUT ${o.qty} ${o.itemCode} [${vkOf(o.vk)}] batch ${o.batchNo ?? '-'} at ${whName(o.warehouseId)}, source DO ${f.t.docNo}`);
      for (const d of f.draws) note(`    draws lot ${d.lot} (${d.from ?? '-'}, batch ${d.batch ?? '-'}) x${d.qty}`);
      for (const [k, b] of f.plan.before) {
        const a = f.plan.after.get(k) ?? b;
        const [wh, item, vk] = k.split('::');
        note(`  BUCKET ${item} [${vkOf(vk)}] at ${whName(wh)}: movements ${b.mov} -> ${a.mov} | open lots ${b.lots} -> ${a.lots}`);
      }
      for (const r of f.plan.refusals) bad(`  REFUSED: ${r}`);
      continue;
    }
    if (f.t.kind === KIND.CANCELLED_DO_OVER_REVERSED) {
      note(`  FINDING: status ${f.d.status}`);
      for (const it of f.items) {
        if (it.plan.done) { note(`  ALREADY DONE: ${it.code} nets to 0 on this DO. Nothing to write.`); continue; }
        note(`  ${it.code} [${vkOf(it.vk)}] at ${whName(it.wh)}: OUT - give-backs = ${it.net} (over-reversed by ${-it.net})`);
        note(`    replacement ${f.t.downstreamDo} OUT: ${it.downstream ? `x${it.downstream.outQty}, lot-backed ${it.downstream.consumed}` : 'none in this bucket'}`);
        for (const l of it.open) note(`    open lot ${short(l.id)} (${l.source_doc_no ?? '-'}, batch ${l.batch_no ?? '-'}) left ${l.qty_remaining}`);
        for (const a of it.plan.attach) note(`  LINK lot ${short(a.lotId)} x${a.qty} -> ${f.t.downstreamDo} OUT (it shipped that unit before the GRN arrived)`);
        for (const w of it.plan.writes) note(`  WRITE ${w.type} ${w.qty} ${it.code} [${vkOf(it.vk)}] batch ${it.cancelBatch ?? '-'}, source ADJUSTMENT ${f.t.docNo} (consumes nothing)`);
        note(`  BUCKET ${it.code} [${vkOf(it.vk)}] at ${whName(it.wh)}: movements ${it.plan.before.mov} -> ${it.plan.after.mov} | open lots ${it.plan.before.lots} -> ${it.plan.after.lots}`);
        for (const r of it.plan.refusals) bad(`  REFUSED: ${r}`);
      }
      continue;
    }
    note(`  FINDING: status ${f.g.status}, received ${ymd(f.g.received_at)} at ${whName(f.g.warehouse_id)}`);
    for (const it of f.items) {
      if (it.missingLine) { bad(`  ${it.code}: no such line`); continue; }
      note(`  ${it.code} line qty ${it.line.qty_accepted}, spec [${vkOf(it.vk)}], PO ${it.batchNo ?? '-'}: GRN net IN ${it.grnNetIn}`);
      if (it.plan.done) { note(`  ALREADY DONE: the GRN's IN for ${it.code} matches the line. Nothing to write.`); continue; }
      note(`    ${f.t.downstreamDo} OUT in this bucket: ${it.downstream ? `x${it.downstream.outQty}, lot-backed ${it.downstream.consumed}` : 'none'}`);
      if (f.t.kind === KIND.GRN_IN_MISSING_SHIP_UNCOSTED) {
        note(`    unit cost: the post-time rule (price at the GRN rate + allocated charge per unit, charge ${it.hasCharge ? 'present' : 'none'}): ${it.unitCost == null ? 'NONE' : 'present'}`);
        note(`    the GRN's other lines with an IN carry: ${it.siblings.map((s) => `${s.code} ${s.matches}`).join(', ') || 'no other line'}`);
      } else {
        const s = it.standIn;
        note(`    stand-in lot: ${s ? `${short(s.id)} received ${s.qtyReceived}, left ${s.qtyRemaining}, movement behind it: ${s.hasMovement ? 'YES' : 'none'}, drawn by ${s.consumedBy.join(', ') || '-'}, at ${new Date(s.receivedAt).toISOString()}` : 'NOT FOUND'}`);
      }
      for (const w of it.plan.writes) note(`  WRITE IN ${w.qty} ${it.code} [${vkOf(it.vk)}] batch ${it.batchNo ?? '-'}, source GRN ${f.t.docNo}${w.closeMintedLot ? '; the lot it opens is closed at once' : ''}`);
      for (const a of it.plan.attach) note(`  LINK the new lot x${a.qty} -> ${f.t.downstreamDo} OUT (the unit it shipped)`);
      note(`  BUCKET ${it.code} [${vkOf(it.vk)}] at ${whName(f.g.warehouse_id)}: movements ${it.plan.before.mov} -> ${it.plan.after.mov} | open lots ${it.plan.before.lots} -> ${it.plan.after.lots}`);
      for (const r of it.plan.refusals) bad(`  REFUSED: ${r}`);
    }
  }
}

/* ---------------------------------------------------------------- writes */

let COLS = null;
async function insertMovement(tx, row, dateSql) {
  if (!COLS) COLS = new Set((await tx`SELECT column_name FROM information_schema.columns
                                       WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));
  const names = Object.keys(row).filter((k) => COLS.has(k));
  const vals = names.map((k) => row[k]);
  const withDate = COLS.has('movement_date');
  const [ins] = await tx.unsafe(
    `INSERT INTO scm.inventory_movements (${names.join(', ')}${withDate ? ', movement_date' : ''})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}${withDate ? `, ${dateSql}` : ''}) RETURNING id`, vals);
  return ins.id;
}
const TODAY_MYT = "(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date";

async function productName(tx, item) {
  const [r] = await tx`SELECT MAX(product_name) AS n FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${item}`;
  return r?.n ?? null;
}

/* Give `qty` of a lot to an OUT that drew nothing for it, and re-cost the OUT. */
async function linkLotToOut(tx, lotId, outId, qty) {
  const [lot] = await tx`SELECT id, warehouse_id, item_code, variant_key, unit_cost_sen, qty_remaining FROM scm.inventory_lots
                          WHERE id = ${lotId} AND company_id = ${CO} FOR UPDATE`;
  const [out] = await tx`SELECT id, qty, source_doc_type, source_doc_id, source_doc_no, variant_key FROM scm.inventory_movements
                          WHERE id = ${outId} AND company_id = ${CO} AND movement_type = 'OUT' FOR UPDATE`;
  if (!lot || !out) throw new Error('lot or OUT vanished under the lock');
  if (Number(lot.qty_remaining) < qty) throw new Error(`lot ${short(lotId)} holds ${lot.qty_remaining}, needs ${qty}`);
  const [used] = await tx`SELECT COALESCE(SUM(qty_consumed), 0)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${outId}`;
  if (used.n + qty > Math.abs(Number(out.qty))) throw new Error(`OUT ${short(outId)} would draw more than its qty`);
  const unit = Number(lot.unit_cost_sen ?? 0);
  await tx`INSERT INTO scm.inventory_lot_consumptions
             (lot_id, warehouse_id, item_code, variant_key, qty_consumed, unit_cost_sen, total_cost_sen,
              consumed_at, source_doc_type, source_doc_id, source_doc_no, movement_id, created_by, company_id)
           VALUES (${lotId}, ${lot.warehouse_id}, ${lot.item_code}, ${out.variant_key}, ${qty}, ${unit}, ${qty * unit},
                   now(), ${out.source_doc_type}, ${out.source_doc_id}, ${out.source_doc_no}, ${outId}, NULL, ${CO})`;
  await tx`UPDATE scm.inventory_lots SET qty_remaining = qty_remaining - ${qty} WHERE id = ${lotId} AND company_id = ${CO}`;
  await tx`
    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.t, unit_cost_sen = CASE WHEN ABS(m.qty) > 0 THEN sub.t / ABS(m.qty) ELSE 0 END
      FROM (SELECT COALESCE(SUM(total_cost_sen), 0) AS t FROM scm.inventory_lot_consumptions WHERE movement_id = ${outId}) sub
     WHERE m.id = ${outId} AND m.company_id = ${CO}`;
}

async function applyAll(tx, facts) {
  const written = [];
  for (const f of facts) {
    if (f.t.kind === KIND.GRN_IN_MISSING_SHIP_UNCOSTED || f.t.kind === KIND.GRN_IN_LOST_ON_REPOST) {
      for (const it of f.items) {
        if (it.plan.done) continue;
        for (const w of it.plan.writes) {
          const id = await insertMovement(tx, {
            movement_type: 'IN', warehouse_id: f.g.warehouse_id, item_code: it.code, variant_key: it.vk,
            product_name: await productName(tx, it.code), qty: w.qty, unit_cost_sen: w.unitCost,
            source_doc_type: 'GRN', source_doc_id: f.g.id, source_doc_no: f.t.docNo, batch_no: it.batchNo,
            notes: movementNotes({ docNo: f.t.docNo, kind: f.t.kind, what: `missing stock IN for ${it.code} x${w.qty}` }), company_id: CO,
          }, /^\d{4}-\d{2}-\d{2}$/.test(ymd(f.g.received_at)) ? `'${ymd(f.g.received_at)}'::date` : TODAY_MYT);
          const minted = await tx`SELECT id FROM scm.inventory_lots WHERE movement_id = ${id} AND company_id = ${CO} AND qty_received = ${w.qty}`;
          if (minted.length !== 1) throw new Error(`${f.t.docNo} ${it.code}: expected one lot opened by the IN, found ${minted.length}`);
          if (w.closeMintedLot) await tx`UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE id = ${minted[0].id} AND company_id = ${CO}`;
          for (const a of it.plan.attach) await linkLotToOut(tx, minted[0].id, a.toOut, a.qty);
          written.push({ doc: f.t.docNo, kind: f.t.kind, id, lotId: minted[0].id, closeMinted: w.closeMintedLot, attachTo: it.plan.attach.map((a) => a.toOut) });
        }
      }
    } else if (f.t.kind === KIND.DO_OUT_MISSING) {
      if (f.plan.done) continue;
      for (const o of f.plan.outs) {
        const id = await insertMovement(tx, {
          movement_type: 'OUT', warehouse_id: o.warehouseId, item_code: o.itemCode, variant_key: o.vk,
          product_name: await productName(tx, o.itemCode), qty: o.qty,
          source_doc_type: 'DO', source_doc_id: f.d.id, source_doc_no: f.t.docNo, batch_no: o.batchNo,
          notes: movementNotes({ docNo: f.t.docNo, kind: f.t.kind, what: `missing stock OUT for ${o.itemCode} x${o.qty}` }), company_id: CO,
        }, TODAY_MYT);
        const [used] = await tx`SELECT COALESCE(SUM(qty_consumed), 0)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${id}`;
        if (used.n !== o.qty) throw new Error(`${f.t.docNo} ${o.itemCode}: the OUT drew ${used.n} of ${o.qty} from lots`);
        written.push({ doc: f.t.docNo, kind: f.t.kind, id });
      }
    } else {
      for (const it of f.items) {
        if (it.plan.done) continue;
        for (const a of it.plan.attach) await linkLotToOut(tx, a.lotId, a.toOut, a.qty);
        for (const w of it.plan.writes) {
          const id = await insertMovement(tx, {
            movement_type: 'ADJUSTMENT', warehouse_id: it.wh, item_code: it.code, variant_key: it.vk,
            product_name: await productName(tx, it.code), qty: w.qty, unit_cost_sen: 0,
            source_doc_type: 'ADJUSTMENT', source_doc_id: f.d.id, source_doc_no: f.t.docNo, batch_no: it.cancelBatch ?? null,
            notes: movementNotes({ docNo: f.t.docNo, kind: f.t.kind, what: `takes back the second give-back of ${it.code} x${-w.qty}` }), company_id: CO,
          }, TODAY_MYT);
          const [used] = await tx`SELECT COUNT(*)::int AS n FROM scm.inventory_lot_consumptions WHERE movement_id = ${id}`;
          if (used.n > 0) throw new Error(`${f.t.docNo} ${it.code}: the ADJUSTMENT drew a lot; refusing`);
          written.push({ doc: f.t.docNo, kind: f.t.kind, id, attachTo: it.plan.attach.map((a) => a.toOut) });
        }
      }
    }
  }
  await tx`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
           VALUES ('GLOBAL', ${randomUUID()}, now(), ${`${TAG}: four half-done documents`})
           ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
             requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
  return written;
}

/* ---------------------------------------------------------------- verify */

async function docStillOff(c, f) {
  if (f.missing) return [];
  if (f.t.kind === KIND.DO_OUT_MISSING || f.t.kind === KIND.CANCELLED_DO_OVER_REVERSED) {
    const docs = [{ docId: f.d.id, docNo: f.t.docNo, createdAt: null }];
    const movs = await c`
      SELECT source_doc_id AS "docId", item_code AS "itemCode",
             SUM(CASE WHEN source_doc_type = 'DO' AND movement_type = 'OUT' THEN qty
                      WHEN source_doc_type = 'DO' AND movement_type = 'IN' THEN -qty
                      WHEN source_doc_type = 'ADJUSTMENT' AND movement_type = 'ADJUSTMENT' THEN -qty ELSE 0 END)::int AS net
        FROM scm.inventory_movements
       WHERE company_id = ${CO} AND source_doc_id = ${f.d.id} AND source_doc_type IN ('DO', 'ADJUSTMENT') GROUP BY 1, 2`;
    if (f.t.kind === KIND.CANCELLED_DO_OVER_REVERSED) return cancelledResidue(docs, movs);
    const lines = await c`SELECT delivery_order_id AS "docId", item_code AS "itemCode", item_group AS "itemGroup", qty
                            FROM scm.delivery_order_items WHERE delivery_order_id = ${f.d.id}`;
    return compareDocItems(docs, lines, movs);
  }
  const docs = [{ docId: f.g.id, docNo: f.t.docNo, createdAt: null }];
  const lines = await c`SELECT grn_id AS "docId", item_code AS "itemCode", item_group AS "itemGroup", qty_accepted AS qty
                          FROM scm.grn_items WHERE grn_id = ${f.g.id}`;
  const movs = await c`
    SELECT source_doc_id AS "docId", item_code AS "itemCode",
           SUM(CASE WHEN movement_type = 'IN' THEN qty WHEN movement_type = 'OUT' THEN -qty ELSE 0 END)::int AS net
      FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_type = 'GRN' AND source_doc_id = ${f.g.id} GROUP BY 1, 2`;
  return compareDocItems(docs, lines, movs);
}

function touchedBuckets(facts) {
  const out = new Map();
  for (const f of facts) {
    if (f.missing) continue;
    if (f.t.kind === KIND.DO_OUT_MISSING) for (const o of f.plan.outs) out.set(`${o.warehouseId}::${o.itemCode}::${o.vk}`, [o.warehouseId, o.itemCode, o.vk]);
    else if (f.t.kind === KIND.CANCELLED_DO_OVER_REVERSED) for (const it of f.items) { if (!it.plan.done) out.set(`${it.wh}::${it.code}::${it.vk}`, [it.wh, it.code, it.vk]); }
    else for (const it of f.items) { if (!it.missingLine && !it.plan.done) out.set(`${f.g.warehouse_id}::${it.code}::${it.vk}`, [f.g.warehouse_id, it.code, it.vk]); }
  }
  return out;
}

async function verify(check, facts, written) {
  let wrong = 0;
  const say = (ok, m) => { if (!ok) wrong += 1; (ok ? note : bad)(`  ${ok ? 'OK ' : 'BAD'} ${m}`); };
  for (const f of facts) {
    const off = await docStillOff(check, f);
    say(off.length === 0, `${f.t.docNo}: movements match its lines${off.length ? ` - still off: ${off.map((o) => `${o.itemCode} lines=${o.expected} movements=${o.actual}`).join('; ')}` : ''}`);
  }
  for (const [, [wh, item, vk]] of touchedBuckets(facts)) {
    const b = await bucket(check, wh, item, vk);
    say(b.mov === b.lots, `${item} [${vkOf(vk)}] at ${short(wh)}: movements ${b.mov}, open lots ${b.lots}`);
  }
  for (const w of written) {
    const [mv] = await check`SELECT notes FROM scm.inventory_movements WHERE id = ${w.id} AND company_id = ${CO}`;
    say(String(mv?.notes ?? '').includes(TAG), `${w.doc} row ${short(w.id)} carries the tag`);
    if (w.closeMinted) {
      const [lot] = await check`SELECT qty_remaining FROM scm.inventory_lots WHERE id = ${w.lotId}`;
      say(Number(lot?.qty_remaining) === 0, `${w.doc} lot ${short(w.lotId)} opened by the IN is closed`);
    }
    for (const outId of w.attachTo ?? []) {
      const [o] = await check`
        SELECT ABS(m.qty)::int AS qty, COALESCE((SELECT SUM(x.qty_consumed) FROM scm.inventory_lot_consumptions x WHERE x.movement_id = m.id), 0)::int AS used
          FROM scm.inventory_movements m WHERE m.id = ${outId} AND m.company_id = ${CO}`;
      say(o && o.used <= o.qty && o.used > 0, `linked OUT ${short(outId)} draws ${o?.used} of ${o?.qty}`);
    }
  }
  return wrong;
}

/* ---------------------------------------------------------------- main */

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} tag=${TAG}`);
  const wh = new Map((await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`).map((w) => [w.id, w.name || w.code]));
  const whName = (id) => (id ? wh.get(id) ?? short(id) : 'NONE');

  const facts = await gather(sql);
  printPlan(facts, whName);
  const refusals = refusalsOf(facts);
  const todo = touchedBuckets(facts).size;
  note(`\n  documents: ${facts.length}; buckets to correct: ${todo}; refusals: ${refusals.length}`);
  for (const r of refusals) bad(`  REFUSED ${r}`);

  if (!APPLY || todo === 0 || refusals.length) {
    note(refusals.length ? '\nNothing written: refused (all four documents go together or not at all).'
      : todo === 0 ? '\nNothing to write: every document already matches its lines.'
        : `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    if (APPLY && refusals.length) process.exitCode = 1;
    return;
  }

  note('\n=== WRITING (one transaction) ===');
  let written = [];
  let again = null;
  try {
    await sql.begin(async (tx) => {
      /* Lock every lot in the touched buckets, then re-read and re-plan: the plan above is a preview. */
      for (const [, [w, item, vk]] of touchedBuckets(facts)) {
        await tx`SELECT id FROM scm.inventory_lots WHERE company_id = ${CO} AND warehouse_id = ${w} AND item_code = ${item}
                  AND COALESCE(variant_key, '') = ${vk} FOR UPDATE`;
      }
      again = await gather(tx);
      const r2 = refusalsOf(again);
      if (r2.length) throw new Error(`changed since the plan: ${r2.join('; ')}`);
      if (planShape(again) !== planShape(facts)) throw new Error('the plan moved between the preview and the lock');
      written = await applyAll(tx, again);
    });
    for (const w of written) note(`  OK ${w.doc} row ${short(w.id)}${w.closeMinted ? ', opened lot closed' : ''}${w.attachTo?.length ? `, linked to OUT ${w.attachTo.map(short).join(',')}` : ''}`);
    note('  allocation recompute requested');
  } catch (e) {
    bad(`  FAIL: ${e.message} (rolled back, nothing written)`);
    await sql.end({ timeout: 5 });
    process.exitCode = 1;
    return;
  }
  await sql.end({ timeout: 5 });

  /* Fresh connection: check the SHAPE the write left, not the count it reported. */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    const wrong = await verify(check, again, written);
    note(`  ${written.length} row(s) written; ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
