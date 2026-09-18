#!/usr/bin/env node
// Write the SUPPLIER'S measurements onto lines whose goods are ALREADY IN — and
// move the stock ledger with them, so the line and its lot stay in one bucket.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE INSTRUCTION, owner 2026-09-11: 「已经收货了的 也是要改的 跟 SO 一起改整个
// transaction flow」. `apply-supplier-sofa-leg.mjs` and
// `apply-supplier-bedframe-variants.mjs` deliberately HOLD those lines, because
// a measurement composes the inventory identity (`computeVariantKey`) and writing
// it alone points the line at a bucket no lot carries — docs/bugs/0722, which
// shipped three delivery orders against nothing and cost them their COGS. This
// tool is the other half they were waiting for: it writes the measurement to
// EVERY document in the chain and re-keys the stock rows in the same
// transaction, so at no point does a line reference a bucket that is not there.
//
// WHAT MOVES, AND WHAT DOES NOT
//   documents   purchase line · its sales line · its goods-received line(s) ·
//               the sales line's delivery line(s)
//   stock       scm.inventory_lots · scm.inventory_movements ·
//               scm.inventory_lot_consumptions — the three BASE tables carrying
//               variant_key. `scm.inventory_balances` is a VIEW (checked, not
//               assumed) and follows on its own; the rack, stock-take and
//               transfer tables carry zero rows for these buckets today and are
//               asserted to still carry zero before anything is written.
//   never       item codes, quantities, prices, lot costs, lot ids, movement
//               ids. Only `variant_key` changes, and only from the OLD bucket to
//               the NEW one.
//
// THE ONE REFUSAL THAT MATTERS. A bucket SHARED with a document outside this
// chain is not repairable this way: moving it would point every other line in it
// at stock that is no longer there — the same defect, in the other direction. It
// is reported, never written. Measured 2026-09-11: 2 of 65 lines.
//
// WHY THE FIFO TRIGGER IS NOT A RISK: `trg_inventory_movement_fifo` is
// `AFTER INSERT` (read from pg_trigger, not assumed), and this tool only ever
// UPDATEs, so no consumption is re-planned by the write.
//
// RE-RUN: convergent. A line already reading the supplier's measurement, with
// its stock under the matching key, produces no plan entry on the next run.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: MOVE THE STOCK WITH THE LINE
//   Run under tsx for the TS import:
//     npx tsx scripts/apply-supplier-variants-with-stock.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { parseSofa, pieceSuffix } from './lib/parse-sofa.mjs';

const CONFIRM_PHRASE = 'MOVE THE STOCK WITH THE LINE';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const line = (s = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${s}` : s);
const rule = () => line('-'.repeat(78));

const DST = process.env.DATABASE_URL;
if (!DST) { console.error('need DATABASE_URL'); process.exit(2); }
// The refusal lives AT the comparison, its exit adjacent.
if (WANTS_APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const APPLY = WANTS_APPLY;

const gz = (f) => JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(here, 'data', f))).toString('utf8').replace(/^﻿/, ''),
);
const norm = (s) => String(s ?? '').trim().toUpperCase();
const modelOf = (code) => { const s = norm(code); const i = s.indexOf('-'); return i < 0 ? s : s.slice(0, i); };
const sizeOf = (code) => { const s = norm(code); const i = s.lastIndexOf('-'); return i < 0 ? s : s.slice(i + 1); };
const bag = (xs) => xs.slice().sort().join('|');
const sameSofa = (a, b) => a.join('+') === b.join('+') || a.slice().reverse().join('+') === b.join('+');
const inches = (v) => { if (v === null || v === undefined) return null; const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(v)); return m ? String(parseFloat(m[1])) : null; };
const bedVariants = (d2) => {
  const out = {};
  const s = String(d2 ?? '').toLowerCase();
  for (const key of ['div', 'gap', 'leg']) {
    const m = new RegExp(`\\b${key}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(s);
    if (m) out[key] = m[1];
  }
  return out;
};

/* Self-test the readers before reporting anything: a matcher that cannot match
   must never read as "nothing to do". */
{
  const v = bedVariants('div:8inch / leg:1inch / gap:16inch');
  const ok = v.div === '8' && v.leg === '1' && v.gap === '16'
    && sizeOf('2038(A)-(SS)') === '(SS)' && inches('10"') === '10' && inches(null) === null
    && pieceSuffix('5540-CSL') === 'CONSOLE'
    && computeVariantKey('sofa', { fabricCode: 'X', seatHeight: '28', legHeight: '6"' }) === 'fabriccode=x|seatheight=28|legheight=6"';
  if (!ok) { console.error('SELF-TEST FAILED on the readers. Refusing to run.'); process.exit(1); }
}

const book = gz('supplier-so-detail-2026-09-11.json.gz');
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

async function findPo(ref) {
  if (!ref) return null;
  const byLinked = async (v) => (await sql`SELECT id, po_number FROM scm.purchase_orders WHERE company_id = ${CO} AND linked_ac_docno = ${v}`)[0] ?? null;
  const byNumber = async (v) => (await sql`SELECT id, po_number FROM scm.purchase_orders WHERE company_id = ${CO} AND po_number = ${v}`)[0] ?? null;
  return (await byLinked(ref)) ?? (await byNumber(ref))
    ?? (/^PO-\d{4}-\d+$/.test(ref) ? await byNumber(`HC-${ref}`) : null);
}

/** Rows in a bucket, per BASE table that carries variant_key. */
async function stockUnder(itemCode, key) {
  const one = async (table) => Number((await sql.unsafe(
    `SELECT count(*)::int AS n FROM scm.${table} WHERE company_id = $1 AND item_code = $2 AND coalesce(variant_key, '') = $3`,
    [CO, itemCode, key],
  ))[0]?.n ?? 0);
  return {
    lots: await one('inventory_lots'),
    movements: await one('inventory_movements'),
    consumptions: await one('inventory_lot_consumptions'),
    rackItems: await one('warehouse_rack_items'),
    rackMoves: await one('warehouse_rack_movements'),
    stockTake: await one('stock_take_lines'),
    transfers: await one('stock_transfer_lines'),
  };
}

/** Every DOCUMENT line resolving to the same bucket — the exclusivity test. */
async function consumersOf(itemCode, group, key) {
  const hits = [];
  const scan = async (table, docCol, joinSql) => {
    const rows = await sql.unsafe(
      `SELECT ${docCol} AS doc, i.id, i.variants FROM scm.${table} i ${joinSql}
        WHERE upper(coalesce(i.item_group, '')) = $1 AND i.item_code = $2`,
      [norm(group), itemCode],
    );
    for (const r of rows) if (computeVariantKey(group, r.variants || {}) === key) hits.push({ doc: r.doc, id: String(r.id) });
  };
  await scan('mfg_sales_order_items', 'i.doc_no', `JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = ${CO}`);
  await scan('purchase_order_items', 'p.po_number', `JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}`);
  await scan('grn_items', 'g.grn_number', `JOIN scm.grns g ON g.id = i.grn_id AND g.company_id = ${CO}`);
  await scan('delivery_order_items', 'd.do_number', `JOIN scm.delivery_orders d ON d.id = i.delivery_order_id AND d.company_id = ${CO}`);
  return hits;
}

/** Everything downstream of one purchase line, and of its sales line. */
async function chainOf(poItemId, soItemId) {
  const grn = await sql`SELECT gi.id, g.grn_number FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                         WHERE gi.purchase_order_item_id = ${poItemId}`;
  const dos = soItemId
    ? await sql`SELECT di.id, d.do_number FROM scm.delivery_order_items di JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                 WHERE di.so_item_id = ${soItemId}`
    : [];
  return { grn, dos };
}

const plan = [];

try {
  line('='.repeat(78));
  line('SUPPLIER MEASUREMENTS ON RECEIVED GOODS — the line and its stock, together');
  line('='.repeat(78));
  line(`   source: ${book._source}`);
  line(`   company ${CO}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  /* ---- Gather every held line: the supplier states a measurement, ours差s,
         and the goods are already in. ---- */
  for (const d of book.documents) {
    const sofa = d.lines.filter((l) => norm(l.group) === 'SOFA');
    const bed = d.lines.filter((l) => norm(l.group) === 'BEDFRAME');
    if (!sofa.length && !bed.length) continue;
    const po = await findPo(d.ourPoRef);
    if (!po) continue;

    if (sofa.length) {
      const ours = await sql`
        SELECT i.id, i.item_code, i.variants, i.so_item_id, i.received_qty
          FROM scm.purchase_order_items i
         WHERE i.purchase_order_id = ${po.id} AND upper(coalesce(i.item_group, '')) = 'SOFA' ORDER BY i.id`;
      if (ours.length && sofa.length === ours.length) {
        const theirs = sofa.map((l) => pieceSuffix(l.code));
        const mine = ours.map((r) => pieceSuffix(r.item_code));
        if (bag(theirs) === bag(mine) && sameSofa(theirs, mine)) {
          const theirLines = theirs.join('+') === mine.join('+') ? sofa : sofa.slice().reverse();
          for (let i = 0; i < ours.length; i += 1) {
            const r = ours[i];
            const want = parseSofa(theirLines[i].desc2 || '', modelOf(theirLines[i].code));
            const legWant = want.leg === null || want.leg === undefined ? null : inches(want.leg);
            if (legWant === null) continue;
            if (inches((r.variants || {}).legHeight) === legWant) continue;
            if (Number(r.received_qty || 0) === 0) continue;   // the plain fill tool owns these
            plan.push({
              poNumber: po.po_number, group: 'sofa', itemCode: r.item_code,
              poItemId: String(r.id), soItemId: r.so_item_id ? String(r.so_item_id) : null,
              before: r.variants || {}, set: { legHeight: `${legWant}"` },
              change: `leg ${(r.variants || {}).legHeight ?? '(blank)'} -> ${legWant}"`,
            });
          }
        }
      }
    }

    if (bed.length) {
      const ours = await sql`
        SELECT i.id, i.item_code, i.variants, i.so_item_id, i.received_qty
          FROM scm.purchase_order_items i
         WHERE i.purchase_order_id = ${po.id} AND upper(coalesce(i.item_group, '')) = 'BEDFRAME' ORDER BY i.id`;
      if (ours.length && bag(bed.map((l) => sizeOf(l.code))) === bag(ours.map((r) => sizeOf(r.item_code)))) {
        const bySize = new Map();
        for (const r of ours) {
          const k = sizeOf(r.item_code);
          if (!bySize.has(k)) bySize.set(k, []);
          bySize.get(k).push(r);
        }
        /* Two beds of one size stating different measurements cannot be told
           apart by anything in this file — skip that document, as the fill tool
           does. */
        const stated = new Map();
        let ambiguous = false;
        for (const l of bed) {
          const k = sizeOf(l.code);
          const v = JSON.stringify(bedVariants(l.desc2));
          if (stated.has(k) && stated.get(k) !== v) ambiguous = true;
          stated.set(k, v);
        }
        if (!ambiguous) {
          for (const l of bed) {
            const pool = bySize.get(sizeOf(l.code));
            if (!pool || !pool.length) continue;
            const r = pool.shift();
            if (Number(r.received_qty || 0) === 0) continue;
            const want = bedVariants(l.desc2);
            const axes = { div: { names: ['divanHeight', 'divan'], write: 'divanHeight' }, gap: { names: ['gap'], write: 'gap' }, leg: { names: ['legHeight', 'leg'], write: 'legHeight' } };
            const set = {};
            const changes = [];
            for (const [k, a] of Object.entries(axes)) {
              if (!(k in want)) continue;
              const have = a.names.map((n) => (r.variants || {})[n]).find((x) => x !== undefined && x !== null && String(x) !== '');
              if (inches(have) === inches(want[k])) continue;
              set[a.write] = `${inches(want[k])}"`;
              changes.push(`${k} ${have ?? '(blank)'} -> ${inches(want[k])}"`);
            }
            if (!Object.keys(set).length) continue;
            plan.push({
              poNumber: po.po_number, group: 'bedframe', itemCode: r.item_code,
              poItemId: String(r.id), soItemId: r.so_item_id ? String(r.so_item_id) : null,
              before: r.variants || {}, set, change: changes.join(', '),
            });
          }
        }
      }
    }
  }

  /* ---- Classify each against the stock ledger. ---- */
  const writable = [];
  const refused = [];
  /* Resolve every chain FIRST, then ask who else is in the bucket — because two
     lines of the PLAN may share one bucket (HC-PO-008506 holds two REGAL (A)-(Q)
     beds under one key, and each read the other as a stranger). A sibling that is
     itself being moved to the SAME new key is not a stranger; it is the rest of
     the move. */
  for (const p of plan) {
    p.oldKey = computeVariantKey(p.group, p.before);
    p.newKey = computeVariantKey(p.group, { ...p.before, ...p.set });
    p.rows = await stockUnder(p.itemCode, p.oldKey);
    p.chain = await chainOf(p.poItemId, p.soItemId);
  }
  const movingTo = new Map();   // item|oldKey -> the new key every plan line takes it to
  const inPlan = new Map();     // item|oldKey -> every document row id the plan moves
  for (const p of plan) {
    const k = `${p.itemCode}|${p.oldKey}`;
    if (movingTo.has(k) && movingTo.get(k) !== p.newKey) movingTo.set(k, null);  // two answers for one bucket
    else if (!movingTo.has(k)) movingTo.set(k, p.newKey);
    const ids = inPlan.get(k) ?? new Set();
    ids.add(p.poItemId);
    if (p.soItemId) ids.add(String(p.soItemId));
    for (const g of p.chain.grn) ids.add(String(g.id));
    for (const d of p.chain.dos) ids.add(String(d.id));
    inPlan.set(k, ids);
  }
  for (const p of plan) {
    const k = `${p.itemCode}|${p.oldKey}`;
    if (movingTo.get(k) === null) { refused.push({ ...p, why: `two lines in this plan move the same bucket to DIFFERENT keys — that is a finding, not a repair` }); continue; }
    p.others = (await consumersOf(p.itemCode, p.group, p.oldKey)).filter((c) => !(inPlan.get(k) ?? new Set()).has(c.id));
    /* The three tables nothing has ever put these buckets in. Asserted rather
       than assumed: if one ever gains a row, this tool must learn to move it
       before it writes anything. */
    p.untouchable = p.rows.rackItems + p.rows.rackMoves + p.rows.stockTake + p.rows.transfers;
    if (p.others.length) refused.push({ ...p, why: `the stock bucket is shared with ${p.others.length} line(s) outside this chain (${p.others.slice(0, 4).map((o) => o.doc).join(', ')}) — moving it would point them at stock that is no longer there` });
    else if (p.untouchable) refused.push({ ...p, why: `${p.untouchable} row(s) sit in rack / stock-take / transfer tables this tool does not move` });
    else writable.push(p);
  }

  const moved = writable.reduce((a, p) => ({
    lots: a.lots + p.rows.lots, movements: a.movements + p.rows.movements, consumptions: a.consumptions + p.rows.consumptions,
  }), { lots: 0, movements: 0, consumptions: 0 });

  rule();
  line(`   lines with goods in whose measurement disagrees   ${plan.length}`);
  line(`   WRITABLE (the bucket is this chain's alone)       ${writable.length}   over ${new Set(writable.map((p) => p.poNumber)).size} purchase order(s)`);
  line(`   REFUSED                                          ${refused.length}`);
  line(`   stock rows that move: lots ${moved.lots} · movements ${moved.movements} · consumptions ${moved.consumptions}`);
  rule();
  for (const p of writable) {
    line(`   MOVE  ${p.poNumber.padEnd(16)} ${p.itemCode.padEnd(20)} ${p.change}`);
    line(`         chain: purchase line + ${p.soItemId ? 'sales line' : 'no sales line'} + ${p.chain.grn.length} GRN + ${p.chain.dos.length} DO`
      + `   · stock: ${p.rows.lots} lot / ${p.rows.movements} movement / ${p.rows.consumptions} consumption row(s)`);
  }
  rule();
  for (const p of refused) line(`   REFUSED ${p.poNumber.padEnd(16)} ${p.itemCode.padEnd(20)} ${p.why}`);

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let docLines = 0;
    let stockRows = 0;
    for (const p of writable) {
      /* TEXT parameters through jsonb_object, never a pre-serialized string on a
         jsonb parameter: the driver types that as json, `variants || $1`
         appends rather than merges, and the block becomes an ARRAY
         (docs/jsonb-double-encoding-coe.md, docs/bugs/0814). */
      const patchKeys = Object.keys(p.set);
      const patchVals = Object.values(p.set).map((v) => String(v));
      /* One transaction per LINE: the documents and the stock rows move
         together or not at all, so no window exists in which a line names a
         bucket that is not there. */
      await sql.begin(async (t) => {
        const bump = async (table, id) => {
          const res = await t.unsafe(
            `UPDATE scm.${table}
                SET variants = coalesce(variants, '{}'::jsonb) || jsonb_object($1::text[], $2::text[])
              WHERE id = $3 AND jsonb_typeof(coalesce(variants, '{}'::jsonb)) = 'object'`,
            [patchKeys, patchVals, id],
          );
          if (Number(res.count ?? 0) === 0) throw new Error(`${table} ${id}: variants is not an object — refusing to merge into a shape this tool does not understand`);
          docLines += 1;
        };
        await bump('purchase_order_items', p.poItemId);
        if (p.soItemId) await bump('mfg_sales_order_items', p.soItemId);
        for (const g of p.chain.grn) await bump('grn_items', g.id);
        for (const d of p.chain.dos) await bump('delivery_order_items', d.id);

        for (const table of ['inventory_lots', 'inventory_movements', 'inventory_lot_consumptions']) {
          const res = await t.unsafe(
            `UPDATE scm.${table} SET variant_key = $1
              WHERE company_id = $2 AND item_code = $3 AND coalesce(variant_key, '') = $4`,
            [p.newKey, CO, p.itemCode, p.oldKey],
          );
          stockRows += Number(res.count ?? 0);
        }
      });
      line(`   moved  ${p.poNumber}  ${p.itemCode}  ${p.change}`);
    }
    line(`APPLIED — ${docLines} document line(s), ${stockRows} stock row(s) re-keyed.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE: for every line, the
       document now reads the measurement AND no stock row is left behind in the
       old bucket. A row count alone would not see a half-move. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = [];
      for (const p of writable) {
        const [row] = await check`SELECT variants FROM scm.purchase_order_items WHERE id = ${p.poItemId}`;
        const nowKey = computeVariantKey(p.group, row?.variants || {});
        if (nowKey !== p.newKey) bad.push(`${p.poNumber} ${p.itemCode}: the line keys as ${JSON.stringify(nowKey)}, wanted ${JSON.stringify(p.newKey)}`);
        for (const table of ['inventory_lots', 'inventory_movements', 'inventory_lot_consumptions']) {
          const left = Number((await check.unsafe(
            `SELECT count(*)::int AS n FROM scm.${table} WHERE company_id = $1 AND item_code = $2 AND coalesce(variant_key, '') = $3`,
            [CO, p.itemCode, p.oldKey],
          ))[0]?.n ?? 0);
          if (left) bad.push(`${p.poNumber} ${p.itemCode}: ${left} ${table} row(s) still in the old bucket`);
        }
      }
      if (bad.length) {
        line(`VERIFY FAILED — ${bad.length} finding(s): ${bad.slice(0, 8).join(' · ')}`);
        process.exitCode = 1;
      } else {
        line(`VERIFY OK — ${writable.length} line(s) and their stock read the same bucket, re-read on a fresh connection.`);
      }
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
