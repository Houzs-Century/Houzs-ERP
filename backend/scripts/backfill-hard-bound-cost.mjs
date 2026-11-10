#!/usr/bin/env node
/* Re-cost company-1 hard-bound DO lines already shipped from their bound PO's lot.

   WHY. Owner decision A (2026-11-10): a company-1 hard-bound sales line's cost
   comes from the receipt of the PO bound to it (GRN price, later the PI price).
   #5619 makes every new shipment do that. Lines shipped before it were costed by
   plain FIFO. The #5614 census (run 42832277079) counted, of 1,221 bound DO OUTs:
   264 uncosted, 52 costed from a lot that names no PO, and mismatches costed from
   another PO's lot. This script plans the three classes it is asked for, using
   that check's own verdicts (lib/hard-bound-cost-analyse.mjs):
     uncosted        the OUT consumed no lot
     lot-po-unknown  costed from a lot that names no PO
     other-po        costed from another PO's lot at a different cost
   A mismatch at the same cost is left alone.

   HOW, per DO bucket (warehouse + item + spec, un-batched), with the repo's own
   machinery and no costing code here (lib/hard-bound-cost-backfill.mjs):
     1. scm.fn_return_do_units_at_cost gives the bucket's units back to the lots
        that paid for them and writes its balancing IN (the resync's return);
     2. one OUT with batch_no = the bound PO; fn_inventory_movement_fifo costs it
        from that PO's lot, exactly as a #5619 shipment is costed;
     3. restampDoActualCost + restampSiFromDo (through lib/pgrest-shim.mjs) copy
        the cost onto the DO line and the SI line.
   Both rows are dated on the original OUT's movement date, so the cost lands in
   the month of the sale. All buckets of one warehouse + item + spec share ONE
   transaction, returns first, so two DOs that took each other's PO lot can swap.

   WHAT IS LEFT ALONE, with the reason printed: a bucket still costed from the
   2026-11-10 cutover repair's lots (the revert in #5616 is putting those back to
   uncosted; run it first and plan again — this plan reads the state now and
   never counts those lines as costed), an OUT that already carries a batch, a
   line with no or several received bound POs, and a line whose bound PO has no
   open lot there under that item + spec for its units (counting units this run
   gives back). A batched OUT with no own lot would only fall back to FIFO.

   CLOSED MONTHS. Costing a DO OUT dated in month M changes the closing stock
   value of M and every later month. The PLAN lists them; APPLY refuses unless
   ALLOW_CLOSED_MONTHS names every one. The nightly stock close re-posts them.

   PUBLIC LOG. Actions logs are public: document numbers, item codes, warehouse
   codes, variant keys, quantities, counts and PO numbers only. No cost, amount,
   price, ratio of money, customer or phone.

   Inputs: COMPANY_ID=1 (only company 1 binds), CUTOVER (default the census's),
   LIMIT (lines printed), ALLOW_CLOSED_MONTHS. MODE=plan (default) writes nothing.
   MODE=apply needs CONFIRM="RECOST HARD-BOUND LINES FROM THEIR BOUND PO".
   Each group's transaction locks its lots and the DOs' movements, re-reads the
   buckets and open lots and refuses the group if anything changed since the
   plan. After the commits a FRESH connection checks the shape: the un-batched
   bucket nets to zero, the bound-PO bucket holds the units, every unit of the
   new OUT was consumed from a lot of the bound PO, each DO's lines carry the
   movement cost, each SI line equals its DO line, and a re-plan finds none of
   the buckets again.

   RE-RUN: inert. A re-costed bucket's un-batched units net to zero, so a second
   plan skips it as nothing-out; a group that failed rolled back whole and is
   planned again. */
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { stampedBatchByBucket } from '../src/scm/lib/hard-bound-cost-batch.ts';
import { analyseHardBoundOuts, chunkList } from './lib/hard-bound-cost-analyse.mjs';
import { DEFAULT_CUTOVER, intEnv } from './lib/variant-key-drift.mjs';
import { REPAIR_DOC_NO } from './lib/cutover-nospec-revert.mjs';
import { parseAllowedMonths, affectedClosedMonths, unallowedMonths } from './lib/cutover-nospec-repair.mjs';
import {
  BACKFILL_CONFIRM_PHRASE, SKIPS, selectBuckets, planGroup, nextSeqs, backfillNote, returnNote,
  groupFingerprint, groupKeyOf, tallyBy,
} from './lib/hard-bound-cost-backfill.mjs';

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync('.dev.vars', 'utf8').match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const say = (m) => console.log(m);

const DSN = resolveUrl();
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const MODE = (process.env.MODE || 'plan').toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && process.env.CONFIRM !== BACKFILL_CONFIRM_PHRASE) { bad(`MODE=apply requires CONFIRM="${BACKFILL_CONFIRM_PHRASE}"`); process.exit(2); }
const CO = Number(process.env.COMPANY_ID);
if (CO !== 1) { bad('COMPANY_ID must be 1: only company 1 binds a line to its PO (company 2 pools)'); process.exit(2); }
const CUTOVER = /^\d{4}-\d{2}-\d{2}$/.test(process.env.CUTOVER ?? '') ? process.env.CUTOVER : DEFAULT_CUTOVER;
const LIMIT = intEnv(process.env.LIMIT, 80, 2000);
const allowed = parseAllowedMonths(process.env.ALLOW_CLOSED_MONTHS);
if (!allowed.ok) { bad(allowed.error); process.exit(2); }
const keyOf = (g, v) => computeVariantKey(g, v && typeof v === 'object' ? v : {});

async function closedMonths(client) {
  const rows = await client`
    SELECT source_doc_no FROM scm.journal_entries
     WHERE company_id = ${CO} AND source_type = 'STOCKADJ'
       AND COALESCE(reversed, false) = false AND COALESCE(posted, true) = true`;
  const re = new RegExp(`^STOCKADJ-${CO}-(\\d{4}-\\d{2})$`);
  return [...new Set(rows.map((r) => re.exec(String(r.source_doc_no ?? ''))?.[1]).filter(Boolean))].sort();
}

/* Every movement of these DOs, for the bucket nets and the correction numbers. */
async function doMovements(client, doIds) {
  const out = [];
  for (const c of chunkList(doIds)) {
    out.push(...await client`
      SELECT id::text AS id, source_doc_id::text AS "doId", warehouse_id::text AS "warehouseId", item_code AS "itemCode",
             COALESCE(variant_key, '') AS vk, batch_no AS batch, movement_type::text AS type, ABS(qty)::int AS qty,
             COALESCE(correction_seq, 0)::int AS seq, product_name AS "productName", source_doc_no AS "docNo"
        FROM scm.inventory_movements
       WHERE company_id = ${CO} AND source_doc_type = 'DO' AND source_doc_id::text = ANY(${c})`);
  }
  return out;
}

/* The lots the un-batched OUTs of these buckets consumed. */
async function bucketConsumptions(client, outIds) {
  const out = [];
  for (const c of chunkList(outIds)) {
    out.push(...await client`
      SELECT c.movement_id::text AS "movementId", c.lot_id::text AS "lotId", c.qty_consumed::int AS qty, l.batch_no AS batch
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_lots l ON l.id = c.lot_id AND l.company_id = ${CO}
       WHERE c.movement_id::text = ANY(${c})`);
  }
  return out;
}

async function openPoLots(client, g, pos) {
  return client`
    SELECT id::text AS "lotId", batch_no AS batch, qty_remaining::int AS qty
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND warehouse_id = ${g.warehouseId}::uuid AND item_code = ${g.itemCode}
       AND COALESCE(variant_key, '') = ${g.vk} AND batch_no = ANY(${pos}) AND qty_remaining > 0`;
}

/* Candidates -> buckets with their nets, releases and fingerprint inputs. */
async function measure(client, cands) {
  const movs = await doMovements(client, [...new Set(cands.map((b) => b.doId))]);
  const maxSeq = new Map();
  for (const m of movs) {
    const k = `${m.doId}\u0001${m.itemCode}\u0001${m.vk}`;
    maxSeq.set(k, Math.max(maxSeq.get(k) ?? 0, m.seq));
  }
  const inBucket = (b, m) => m.doId === b.doId && m.warehouseId === b.warehouseId && m.itemCode === b.itemCode && m.vk === b.vk && !m.batch;
  const unbatchedOutIds = [];
  for (const b of cands) {
    const rows = movs.filter((m) => inBucket(b, m));
    b.netQty = rows.reduce((s, m) => s + (m.type === 'OUT' ? m.qty : m.type === 'IN' ? -m.qty : 0), 0);
    b.outRowIds = rows.filter((m) => m.type === 'OUT').map((m) => m.id);
    b.productName = rows.find((m) => m.productName)?.productName ?? null;
    b.docNo = rows.find((m) => m.docNo)?.docNo ?? b.doNo;
    unbatchedOutIds.push(...b.outRowIds);
  }
  const cons = await bucketConsumptions(client, unbatchedOutIds);
  for (const b of cands) {
    const mine = cons.filter((c) => b.outRowIds.includes(c.movementId));
    b.consumed = mine.map((c) => `${c.lotId}:${c.qty}`);
    b.releases = new Map();
    for (const c of mine) if (c.batch) b.releases.set(c.batch, (b.releases.get(c.batch) ?? 0) + c.qty);
  }
  return { movs, maxSeq };
}

/* The whole plan, from the live state. */
async function buildPlan(client) {
  const ids = (await client`
    SELECT m.id::text AS id FROM scm.inventory_movements m
      JOIN scm.delivery_orders d ON d.id = m.source_doc_id AND d.company_id = ${CO}
     WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO' AND m.created_at >= ${CUTOVER}
       AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'`).map((r) => r.id);
  const rows = [];
  for (const c of chunkList(ids)) rows.push(...await analyseHardBoundOuts(client, CO, c));
  const buckets = selectBuckets(rows, REPAIR_DOC_NO);
  const cands = buckets.filter((b) => !b.skip);
  const { maxSeq } = cands.length ? await measure(client, cands) : { maxSeq: new Map() };
  for (const b of cands) if (!(b.netQty > 0)) b.skip = 'nothing-out';
  const groups = new Map();
  for (const b of cands.filter((x) => !x.skip)) {
    const k = groupKeyOf(b);
    const g = groups.get(k) ?? { key: k, warehouseId: b.warehouseId, wh: b.wh, itemCode: b.itemCode, vk: b.vk, buckets: [] };
    g.buckets.push(b);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const pos = [...new Set(g.buckets.map((b) => b.boundPo))];
    g.openLots = await openPoLots(client, g, pos);
    const openByPo = new Map();
    for (const l of g.openLots) openByPo.set(l.batch, (openByPo.get(l.batch) ?? 0) + l.qty);
    const decided = planGroup(g.buckets, openByPo);
    for (const b of g.buckets) if (decided.get(b.key) !== 'recost') b.skip = 'own-po-lot-not-available';
    g.recost = g.buckets.filter((b) => !b.skip);
    g.fingerprint = groupFingerprint({ buckets: g.buckets, openLots: g.openLots });
  }
  return { rows, buckets, groups: [...groups.values()].filter((g) => g.recost.length), maxSeq };
}

function printPlan(plan, closed, affected) {
  const hb = plan.rows.filter((r) => r.hardBound);
  note(`census: ${plan.rows.length} company-${CO} DO OUT row(s) since ${CUTOVER}, ${hb.length} hard-bound`);
  for (const [v, n] of tallyBy(hb, (r) => r.verdict)) say(`    ${String(n).padStart(6)}  ${v}`);
  note(`candidate DO buckets (uncosted / lot-po-unknown / other-po): ${plan.buckets.length}`);
  for (const [c, n] of tallyBy(plan.buckets, (b) => b.classes.join('+'))) say(`    ${String(n).padStart(6)}  ${c}`);
  const doing = plan.groups.flatMap((g) => g.recost);
  const skipped = plan.buckets.filter((b) => b.skip);
  note(`buckets to re-cost from their bound PO: ${doing.length}; units ${doing.reduce((s, b) => s + b.netQty, 0)}; DOs ${new Set(doing.map((b) => b.doId)).size}; warehouse x item x spec groups ${plan.groups.length}`);
  for (const [c, n] of tallyBy(doing, (b) => b.classes.join('+'))) say(`    ${String(n).padStart(6)}  ${c}`);
  note(`left alone: ${skipped.length} bucket(s)`);
  for (const [k, desc] of SKIPS) {
    const n = skipped.filter((b) => b.skip === k).length;
    if (n) say(`    ${String(n).padStart(6)}  ${k} — ${desc}`);
  }
  say('\n-- buckets to re-cost --');
  for (const b of doing.slice(0, LIMIT)) {
    say(`  ${b.doNo} | ${b.itemCode} @ ${b.wh ?? '-'} | vk "${b.vk}" | ${b.netQty} unit(s) | ${b.classes.join('+')} | bound PO ${b.boundPo} | ${b.outDate}`);
  }
  if (doing.length > LIMIT) say(`  ... ${doing.length - LIMIT} more (raise LIMIT)`);
  say('\n-- left alone --');
  for (const b of skipped.slice(0, LIMIT)) {
    say(`  ${b.doNo} | ${b.itemCode} @ ${b.wh ?? '-'} | vk "${b.vk}" | ${b.classes.join('+')} | bound PO ${[...b.boundPoNos].join(', ') || '-'} | ${b.skip}`);
  }
  if (skipped.length > LIMIT) say(`  ... ${skipped.length - LIMIT} more (raise LIMIT)`);
  note(`closed stock months: ${closed.join(', ') || 'none'}`);
  note(`closed months this backfill changes: ${affected.join(', ') || 'none'}`);
}

async function main() {
  const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} cutover=${CUTOVER}`);
  let plan;
  let closed;
  await sql.begin('read only', async (tx) => {
    plan = await buildPlan(tx);
    closed = await closedMonths(tx);
  });
  const doing = plan.groups.flatMap((g) => g.recost);
  const affected = affectedClosedMonths(doing.map((b) => b.outDate.slice(0, 7)), closed);
  printPlan(plan, closed, affected);
  const missing = unallowedMonths(affected, allowed.months);
  if (missing.length) note(`APPLY needs ALLOW_CLOSED_MONTHS=${affected.join(',')} (not yet allowed: ${missing.join(', ')})`);

  if (!APPLY || doing.length === 0) {
    note(doing.length ? `\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${BACKFILL_CONFIRM_PHRASE}"${affected.length ? ` ALLOW_CLOSED_MONTHS=${affected.join(',')}` : ''}.` : '\nNothing to re-cost.');
    await sql.end({ timeout: 5 });
    return;
  }
  if (missing.length) {
    bad(`REFUSED: the backfill changes closed stock month(s) ${missing.join(', ')}. Set ALLOW_CLOSED_MONTHS to name them once the owner agrees.`);
    await sql.end({ timeout: 5 });
    process.exitCode = 1;
    return;
  }

  /* ---- write, one transaction per warehouse x item x spec ---- */
  note('\n=== WRITING ===');
  const cols = new Set((await sql`SELECT column_name FROM information_schema.columns
                                   WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));
  const done = [];
  const doIds = new Set();
  for (const g of plan.groups) {
    const label = `${g.itemCode} @ ${g.wh ?? g.warehouseId.slice(0, 8)} vk "${g.vk}"`;
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM scm.inventory_lots WHERE company_id = ${CO} AND warehouse_id = ${g.warehouseId}::uuid
                  AND item_code = ${g.itemCode} FOR UPDATE`;
        await tx`SELECT id FROM scm.inventory_movements WHERE company_id = ${CO} AND source_doc_type = 'DO'
                  AND source_doc_id::text = ANY(${[...new Set(g.buckets.map((b) => b.doId))]}) AND item_code = ${g.itemCode} FOR UPDATE`;
        const again = g.buckets.map((b) => ({ ...b }));
        const { maxSeq } = await measure(tx, again);
        const openLots = await openPoLots(tx, g, [...new Set(g.buckets.map((b) => b.boundPo))]);
        if (groupFingerprint({ buckets: again, openLots }) !== g.fingerprint) throw new Error('changed since the plan');
        const todo = again.filter((b) => g.recost.some((r) => r.key === b.key));
        const seqs = new Map(todo.map((b) => [b.key, nextSeqs(maxSeq, b.doId, b.itemCode, b.vk)]));
        /* 1. Every return first, so a lot one DO gives back can serve another. */
        for (const b of todo) {
          const { returnSeq } = seqs.get(b.key);
          const [r] = await tx`SELECT qty_returned::int AS q FROM scm.fn_return_do_units_at_cost(
              ${b.doId}::uuid, ${b.warehouseId}::uuid, ${b.itemCode}, ${b.vk}, NULL::text, ${b.netQty}::int,
              ${returnSeq}::int, NULL::uuid, ${returnNote(b.boundPo)})`;
          if (!r || r.q !== b.netQty) throw new Error(`${b.doNo}: returned ${r?.q ?? 0} of ${b.netQty}`);
          if (cols.has('movement_date')) {
            const up = await tx`UPDATE scm.inventory_movements SET movement_date = ${b.outDate}::date
                                 WHERE company_id = ${CO} AND source_doc_type = 'DO' AND source_doc_id = ${b.doId}::uuid
                                   AND movement_type = 'IN' AND item_code = ${b.itemCode} AND COALESCE(variant_key, '') = ${b.vk}
                                   AND correction_seq = ${returnSeq} RETURNING id`;
            if (up.length !== 1) throw new Error(`${b.doNo}: expected one balancing IN, found ${up.length}`);
          }
        }
        /* 2. The OUT under the bound PO; the FIFO trigger costs it from that PO's lot. */
        for (const b of todo) {
          const row = {
            movement_type: 'OUT', warehouse_id: b.warehouseId, item_code: b.itemCode, variant_key: b.vk,
            product_name: b.productName, qty: b.netQty, batch_no: b.boundPo, source_doc_type: 'DO',
            source_doc_id: b.doId, source_doc_no: b.docNo, correction_seq: seqs.get(b.key).outSeq,
            notes: backfillNote(b.boundPo, b.classes), company_id: CO,
            ...(cols.has('movement_date') ? { movement_date: b.outDate } : {}),
          };
          const names = Object.keys(row).filter((k) => cols.has(k));
          const [ins] = await tx.unsafe(`INSERT INTO scm.inventory_movements (${names.join(', ')})
             VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id::text AS id`, names.map((k) => row[k]));
          const [c] = await tx`SELECT COALESCE(SUM(c.qty_consumed), 0)::int AS q,
                                      COUNT(*) FILTER (WHERE l.batch_no IS DISTINCT FROM ${b.boundPo})::int AS other
                                 FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id
                                WHERE c.movement_id = ${ins.id}::uuid`;
          if (c.q !== b.netQty || c.other !== 0) throw new Error(`${b.doNo}: the new OUT took ${c.q} of ${b.netQty} unit(s), ${c.other} lot(s) not of ${b.boundPo}`);
          b.newOutId = ins.id;
        }
        await tx`INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
                 VALUES ('GLOBAL', ${randomUUID()}, now(), ${`hard-bound cost backfill ${g.itemCode}`})
                 ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
                   requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
        for (const b of todo) { doIds.add(b.doId); done.push(b); }
      });
      note(`  OK   ${label}: ${g.recost.length} bucket(s)`);
    } catch (e) {
      bad(`  FAIL ${label}: ${e.message} (rolled back, nothing written for it)`);
      process.exitCode = 1;
    }
  }
  note(`  committed: ${done.length} of ${doing.length} bucket(s)`);

  if (doIds.size) {
    note(`\n=== RESTAMPING ${doIds.size} DO(s) (restampDoActualCost + restampSiFromDo) ===`);
    const { restampDoActualCost } = await import('../src/scm/routes/delivery-orders-mfg.ts');
    const { restampSiFromDo } = await import('../src/scm/lib/recost.ts');
    const { pgrestShim } = await import('./lib/pgrest-shim.mjs');
    const sb = pgrestShim(sql, 'scm');
    let failed = 0;
    for (const doId of doIds) {
      try {
        await restampDoActualCost(sb, doId);
        await restampSiFromDo(sb, doId);
        if (sb.__gaps.length) throw new Error(`shim gap: ${sb.__gaps.join('; ')}`);
      } catch (e) { failed += 1; bad(`  restamp ${doId.slice(0, 8)}: ${e.message}`); }
    }
    note(`  restamped ${doIds.size - failed} of ${doIds.size}${failed ? ' — re-run restamp-do-actual-cost.mjs for the failed ones' : ''}`);
    if (failed) process.exitCode = 1;
  }
  await sql.end({ timeout: 5 });

  /* ---- fresh connection: the SHAPE the writes left ---- */
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('\n=== VERIFIED ON A FRESH CONNECTION ===');
    let wrong = 0;
    const ok = (good, m) => { if (!good) { wrong += 1; bad(`  BAD ${m}`); } };
    const movs = await doMovements(check, [...doIds]);
    for (const b of done) {
      const rows = movs.filter((m) => m.doId === b.doId && m.warehouseId === b.warehouseId && m.itemCode === b.itemCode && m.vk === b.vk);
      const net = (batch) => rows.filter((m) => (m.batch ?? null) === batch).reduce((s, m) => s + (m.type === 'OUT' ? m.qty : m.type === 'IN' ? -m.qty : 0), 0);
      ok(net(null) === 0, `${b.doNo} ${b.itemCode}: un-batched bucket nets ${net(null)}, expected 0`);
      ok(net(b.boundPo) === b.netQty, `${b.doNo} ${b.itemCode}: ${b.boundPo} bucket nets ${net(b.boundPo)}, expected ${b.netQty}`);
      const stamped = stampedBatchByBucket(rows.map((m) => ({
        movement_type: m.type, warehouse_id: m.warehouseId, item_code: m.itemCode, variant_key: m.vk,
        batch_no: m.batch, qty: m.qty, correction_seq: m.seq,
      }))).get(`${b.warehouseId}::${b.itemCode}::${b.vk}`);
      ok(stamped === b.boundPo, `${b.doNo} ${b.itemCode}: the DO seams read batch ${stamped ?? 'none'}, expected ${b.boundPo}`);
      const [c] = await check`SELECT COALESCE(SUM(c.qty_consumed), 0)::int AS q,
                                     COUNT(*) FILTER (WHERE l.batch_no IS DISTINCT FROM ${b.boundPo})::int AS other
                                FROM scm.inventory_lot_consumptions c JOIN scm.inventory_lots l ON l.id = c.lot_id AND l.company_id = ${CO}
                               WHERE c.movement_id = ${b.newOutId}::uuid`;
      ok(c.q === b.netQty && c.other === 0, `${b.doNo} ${b.itemCode}: new OUT consumed ${c.q} of ${b.netQty} from ${b.boundPo}, ${c.other} other lot(s)`);
    }
    /* DO lines carry the movement cost; SI lines carry their DO line's. Compared, never printed. */
    for (const doId of doIds) {
      const lines = await check`
        SELECT i.id::text AS id, i.item_code AS "itemCode", i.item_group AS "itemGroup", i.variants,
               COALESCE(i.line_cost_sen, 0)::bigint AS lc, COALESCE(i.unit_cost_sen, 0)::bigint AS uc
          FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id AND d.company_id = ${CO}
         WHERE i.delivery_order_id = ${doId}::uuid`;
      const doNo = done.find((b) => b.doId === doId)?.doNo ?? doId.slice(0, 8);
      for (const b of done.filter((x) => x.doId === doId)) {
        const mine = lines.filter((l) => l.itemCode === b.itemCode && keyOf(l.itemGroup, l.variants) === b.vk);
        const [mv] = await check`
          SELECT COALESCE(SUM(CASE movement_type WHEN 'OUT' THEN COALESCE(total_cost_sen, 0) WHEN 'IN' THEN -COALESCE(total_cost_sen, 0) ELSE 0 END), 0)::bigint AS cost
            FROM scm.inventory_movements
           WHERE company_id = ${CO} AND source_doc_type = 'DO' AND source_doc_id = ${doId}::uuid
             AND item_code = ${b.itemCode} AND COALESCE(variant_key, '') = ${b.vk}`;
        ok(mine.length > 0 && mine.reduce((s, l) => s + Number(l.lc), 0) === Number(mv.cost),
          `${doNo} ${b.itemCode}: DO line cost does not equal the movement cost (${mine.length} line(s))`);
      }
      const ucById = new Map(lines.map((l) => [l.id, Number(l.uc)]));
      const si = lines.length === 0 ? [] : await check`
        SELECT sii.do_item_id::text AS "doItemId", COALESCE(sii.unit_cost_sen, 0)::bigint AS uc
          FROM scm.sales_invoice_items sii JOIN scm.sales_invoices s ON s.id = sii.sales_invoice_id AND s.company_id = ${CO}
         WHERE sii.do_item_id::text = ANY(${lines.map((l) => l.id)}) AND UPPER(COALESCE(s.status::text, '')) <> 'CANCELLED'`;
      const off = si.filter((s) => ucById.get(s.doItemId) !== Number(s.uc)).length;
      ok(off === 0, `${doNo}: ${off} of ${si.length} SI line(s) differ from their DO line`);
    }
    const replan = await buildPlan(check);
    const again = new Set(replan.groups.flatMap((g) => g.recost).map((b) => b.key));
    const back = done.filter((b) => again.has(b.key)).length;
    ok(back === 0, `a re-plan selects ${back} of the ${done.length} re-costed bucket(s) again`);
    note(`  ${done.length} bucket(s), ${doIds.size} DO(s) checked; ${wrong} check(s) failed`);
    if (wrong > 0) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch((e) => { bad(e.message); process.exit(1); });
