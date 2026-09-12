#!/usr/bin/env node
// Carry the SUPPLIER'S stated options onto our documents — the drawer, the
// headboard, the covering, the nylon — across the whole chain, and move the
// stock with the line wherever goods are already in.
// MODE=plan by default; MODE=apply needs CONFIRM.
//
// THE ASK (owner, 2026-09-12): 「跟着 supplier 改完我们的 SO PO GR DO 等等先，因为
// 我们之前是没有规格和 sofa compartment 的，所以要修复先」.
//
// WHAT WAS MISSING. The compartment and the measurements were aligned on
// 2026-09-11; the OPTIONS were not. Measured on production the same day, over
// the 375 supplier documents that match one of our purchase orders and the 614
// lines that pair line-for-line: 375 agree, **177 are missing an option the
// supplier states**, and 111 carry one the supplier does not state.
//
// The supplier states them in `Detail Description 2`, after the measurements:
//   div:8inch / gap:14inch / Right Drawer, HB Straight
//   div:10inch / gap:14inch / Front Drawer, HB Fully Cover, Divan Full Cover
// and the vocabulary is our own catalogue's: Nylon Fabric 152 rows, HB Fully
// Cover 84, HB Straight 64, Divan Full Cover 60, Front Drawer 45, Divan Curve
// 39, Right Drawer 28, Divan Top Fully Cover 26, Left Drawer 24, No Side Panel 9.
//
// ONLY WHAT THE CATALOGUE ALREADY HOLDS. A phrase is written only when
// `scm.special_addons` holds that exact code for this company. Everything else —
// `Extend 5"`, `no layering`, `OTHER: ARM 12"` — is a free-text instruction and
// its home is the special-order NOTE, not the variant key (the owner's rule
// recorded in special-order-text-is-the-home-for-spec). Those are counted and
// listed, never invented as options.
//
// IT ADDS, IT DOES NOT REMOVE. An option WE carry that the supplier does not
// state may be a later amendment of ours, and the supplier listing is stale
// where we amended (supplier-listing-is-stale-where-we-amended). Those 111 lines
// are reported for a human, never stripped.
//
// THE STOCK MOVES WITH THE LINE. `specials` composes `computeVariantKey`, so
// adding one re-buckets the line. Where goods are already in, the chain's rows in
// inventory_lots / inventory_movements / inventory_lot_consumptions are re-keyed
// in the SAME transaction — the discipline of apply-supplier-variants-with-stock,
// and the defect it exists to avoid is docs/bugs/0722. A bucket shared with a
// document OUTSIDE this chain is refused and named.
//
// RE-RUN: convergent. A line already carrying the supplier's options produces no
// plan entry on the next run.
//
//   DATABASE_URL   required
//   COMPANY_ID     optional, default 1
//   GROUPS         optional, default SOFA,BEDFRAME
//   MODE           plan (default) | apply
//   CONFIRM        required for apply: CARRY THE SUPPLIER OPTIONS
//   Run under tsx for the TS import:
//     npx tsx scripts/apply-supplier-specials.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { computeVariantKey } from '../src/scm/shared/variant-key.ts';
import { pieceSuffix } from './lib/parse-sofa.mjs';

const CONFIRM_PHRASE = 'CARRY THE SUPPLIER OPTIONS';
const MODE = String(process.env.MODE || 'plan').toLowerCase();
const WANTS_APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const GROUPS = String(process.env.GROUPS || 'SOFA,BEDFRAME').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
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
const sizeOf = (code) => { const s = norm(code); const i = s.lastIndexOf('-'); return i < 0 ? s : s.slice(i + 1); };
const keyOf = (grp, code) => (grp === 'SOFA' ? pieceSuffix(code) : sizeOf(code));

const book = gz('supplier-so-detail-2026-09-11.json.gz');
const sql = postgres(DST, { ssl: 'require', max: 1, prepare: false });

/* Self-test the readers before reporting: a matcher that cannot match must never
   read as "nothing to do". */
{
  const ok = keyOf('SOFA', '5540-1A(LHF)') === '1A(LHF)' && keyOf('SOFA', '5540-CSL') === 'CONSOLE'
    && keyOf('BEDFRAME', '2038(A)-(SS)') === '(SS)' && keyOf('BEDFRAME', '1007-(Q)') === '(Q)';
  if (!ok) { console.error('SELF-TEST FAILED on the line readers. Refusing to run.'); process.exit(1); }
}

async function findPo(ref) {
  if (!ref) return null;
  const by = async (col, v) => (await sql.unsafe(
    `SELECT id, po_number FROM scm.purchase_orders WHERE company_id = $1 AND ${col} = $2`, [CO, v]))[0] ?? null;
  return (await by('linked_ac_docno', ref)) ?? (await by('po_number', ref))
    ?? (/^PO-\d{4}-\d+$/.test(ref) ? await by('po_number', `HC-${ref}`) : null);
}

/** Everything downstream of one purchase line, and of its sales line. */
async function chainOf(poItemId, soItemId) {
  const grn = await sql`SELECT gi.id FROM scm.grn_items gi WHERE gi.purchase_order_item_id = ${poItemId}`;
  const dos = soItemId
    ? await sql`SELECT di.id FROM scm.delivery_order_items di WHERE di.so_item_id = ${soItemId}`
    : [];
  return { grn: grn.map((r) => String(r.id)), dos: dos.map((r) => String(r.id)) };
}

/** Every DOCUMENT line resolving to the same stock bucket. */
async function consumersOf(itemCode, group, key) {
  const hits = [];
  const scan = async (table, docCol, joinSql) => {
    const rows = await sql.unsafe(
      `SELECT ${docCol} AS doc, i.id, i.variants FROM scm.${table} i ${joinSql}
        WHERE upper(coalesce(i.item_group, '')) = $1 AND i.item_code = $2`, [norm(group), itemCode]);
    for (const r of rows) if (computeVariantKey(group, r.variants || {}) === key) hits.push({ doc: r.doc, id: String(r.id) });
  };
  await scan('mfg_sales_order_items', 'i.doc_no', `JOIN scm.mfg_sales_orders s ON s.doc_no = i.doc_no AND s.company_id = ${CO}`);
  await scan('purchase_order_items', 'p.po_number', `JOIN scm.purchase_orders p ON p.id = i.purchase_order_id AND p.company_id = ${CO}`);
  await scan('grn_items', 'g.grn_number', `JOIN scm.grns g ON g.id = i.grn_id AND g.company_id = ${CO}`);
  await scan('delivery_order_items', 'd.do_number', `JOIN scm.delivery_orders d ON d.id = i.delivery_order_id AND d.company_id = ${CO}`);
  return hits;
}

async function stockRows(itemCode, key) {
  const one = async (t) => Number((await sql.unsafe(
    `SELECT count(*)::int AS n FROM scm.${t} WHERE company_id = $1 AND item_code = $2 AND coalesce(variant_key,'') = $3`,
    [CO, itemCode, key]))[0]?.n ?? 0);
  return {
    lots: await one('inventory_lots'),
    movements: await one('inventory_movements'),
    consumptions: await one('inventory_lot_consumptions'),
    untouchable: (await one('warehouse_rack_items')) + (await one('warehouse_rack_movements'))
      + (await one('stock_take_lines')) + (await one('stock_transfer_lines')),
  };
}

try {
  line('='.repeat(78));
  line('SUPPLIER OPTIONS — carry what the factory recorded onto our documents');
  line('='.repeat(78));
  line(`   source: ${book._source}`);
  line(`   company ${CO}   groups ${GROUPS.join(',')}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);

  /* The catalogue is the vocabulary. A phrase becomes an option only when this
     company already holds that exact code. */
  const cat = await sql`SELECT code FROM scm.special_addons WHERE company_id = ${CO}`;
  const known = new Map(cat.map((r) => [String(r.code).trim().toLowerCase(), String(r.code)]));
  line(`   catalogue options for this company: ${known.size}`);

  const plan = [];
  const freeText = new Map();
  let compared = 0;
  let agreed = 0;
  const oursOnly = [];

  for (const d of book.documents) {
    const po = await findPo(d.ourPoRef);
    if (!po) continue;
    const ours = await sql`
      SELECT i.id, i.item_code, i.variants, i.so_item_id, i.received_qty,
             upper(coalesce(i.item_group, '')) AS grp
        FROM scm.purchase_order_items i WHERE i.purchase_order_id = ${po.id} ORDER BY i.id`;
    for (const grp of GROUPS) {
      const theirs = d.lines.filter((l) => norm(l.group) === grp);
      const mine = ours.filter((r) => r.grp === grp);
      if (!theirs.length || !mine.length) continue;
      const pool = new Map();
      for (const r of mine) {
        const k = keyOf(grp, r.item_code);
        if (!pool.has(k)) pool.set(k, []);
        pool.get(k).push(r);
      }
      for (const l of theirs) {
        const cand = pool.get(keyOf(grp, l.code));
        if (!cand || !cand.length) continue;
        const r = cand.shift();
        compared += 1;

        const want = new Set();
        for (const part of String(l.desc2 || '').split(/[/,;]/)) {
          const t = part.trim();
          if (!t || /^(div|gap|leg)\s*:/i.test(t)) continue;     // the measurement tools own these
          const code = known.get(t.toLowerCase());
          if (code) want.add(code);
          else if (t.length > 2) freeText.set(t.replace(/\d+/g, 'N'), (freeText.get(t.replace(/\d+/g, 'N')) ?? 0) + 1);
        }
        const have = new Set((r.variants?.specials ?? []).map(String));
        const add = [...want].filter((x) => !have.has(x));
        const only = [...have].filter((x) => !want.has(x));
        if (only.length) oursOnly.push({ po: po.po_number, code: r.item_code, only: only.join(', ') });
        if (!add.length) { agreed += 1; continue; }

        plan.push({
          poNumber: po.po_number, group: grp.toLowerCase(), itemCode: r.item_code,
          poItemId: String(r.id), soItemId: r.so_item_id ? String(r.so_item_id) : null,
          before: r.variants ?? {}, add,
          receivedQty: Number(r.received_qty ?? 0),
        });
      }
    }
  }

  /* Classify against the stock ledger, exactly as the measurement tool does. */
  const writable = [];
  const refused = [];
  for (const p of plan) {
    p.after = { ...p.before, specials: [...new Set([...(p.before.specials ?? []).map(String), ...p.add])] };
    p.oldKey = computeVariantKey(p.group, p.before);
    p.newKey = computeVariantKey(p.group, p.after);
    p.chain = await chainOf(p.poItemId, p.soItemId);
    p.rows = p.oldKey === p.newKey ? { lots: 0, movements: 0, consumptions: 0, untouchable: 0 } : await stockRows(p.itemCode, p.oldKey);
  }
  const inPlan = new Map();
  for (const p of plan) {
    const k = `${p.itemCode}|${p.oldKey}`;
    const ids = inPlan.get(k) ?? new Set();
    ids.add(p.poItemId);
    if (p.soItemId) ids.add(p.soItemId);
    for (const g of p.chain.grn) ids.add(g);
    for (const dd of p.chain.dos) ids.add(dd);
    inPlan.set(k, ids);
  }
  for (const p of plan) {
    if (p.rows.untouchable) { refused.push({ ...p, why: `${p.rows.untouchable} row(s) in rack / stock-take / transfer tables this tool does not move` }); continue; }
    if (p.oldKey === p.newKey || (p.rows.lots + p.rows.movements + p.rows.consumptions) === 0) { writable.push(p); continue; }
    const others = (await consumersOf(p.itemCode, p.group, p.oldKey))
      .filter((c) => !(inPlan.get(`${p.itemCode}|${p.oldKey}`) ?? new Set()).has(c.id));
    if (others.length) refused.push({ ...p, why: `the stock bucket is shared with ${others.length} line(s) outside this chain (${others.slice(0, 4).map((o) => o.doc).join(', ')})` });
    else writable.push(p);
  }

  rule();
  line(`   lines compared line-for-line                 ${compared}`);
  line(`   already carry every option the supplier states ${agreed}`);
  line(`   MISSING an option                            ${plan.length}`);
  line(`   WRITABLE                                     ${writable.length}   over ${new Set(writable.map((p) => p.poNumber)).size} purchase order(s)`);
  line(`   REFUSED                                      ${refused.length}`);
  line(`   we carry an option the supplier does not state ${oursOnly.length}   <- reported, never removed`);
  rule();
  const byAdd = new Map();
  for (const p of writable) for (const a of p.add) byAdd.set(a, (byAdd.get(a) ?? 0) + 1);
  line('   options that would be added:');
  for (const [k, n] of [...byAdd].sort((a, b) => b[1] - a[1])) line(`      ${String(n).padStart(4)}  ${k}`);
  rule();
  for (const p of writable.slice(0, 40)) {
    line(`   ADD  ${p.poNumber.padEnd(16)} ${p.itemCode.padEnd(22)} + ${p.add.join(', ')}`
      + `   chain: ${p.chain.grn.length} GRN, ${p.chain.dos.length} DO · stock ${p.rows.lots}/${p.rows.movements}/${p.rows.consumptions}`);
  }
  if (writable.length > 40) line(`   ... and ${writable.length - 40} more`);
  rule();
  for (const p of refused) line(`   REFUSED ${p.poNumber.padEnd(16)} ${p.itemCode.padEnd(22)} ${p.why}`);
  rule();
  line('   supplier phrases with NO catalogue option — these are free-text instructions,');
  line('   and their home is the special-order NOTE, not the variant key. Never invented here:');
  for (const [k, n] of [...freeText].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`      ${String(n).padStart(4)}  ${k}`);

  if (!APPLY) {
    rule();
    line('PLAN ONLY — nothing was written.');
    line(`To write: MODE=apply CONFIRM="${CONFIRM_PHRASE}"`);
  } else {
    rule();
    let docLines = 0;
    let stockMoved = 0;
    for (const p of writable) {
      const specials = p.after.specials;
      await sql.begin(async (t) => {
        const bump = async (table, id) => {
          const res = await t.unsafe(
            `UPDATE scm.${table}
                SET variants = coalesce(variants, '{}'::jsonb) || jsonb_build_object('specials', $1::jsonb)
              WHERE id = $2 AND jsonb_typeof(coalesce(variants, '{}'::jsonb)) = 'object'`,
            [JSON.stringify(specials), id]);
          if (Number(res.count ?? 0) === 0) throw new Error(`${table} ${id}: variants is not an object`);
          docLines += 1;
        };
        await bump('purchase_order_items', p.poItemId);
        if (p.soItemId) await bump('mfg_sales_order_items', p.soItemId);
        for (const g of p.chain.grn) await bump('grn_items', g);
        for (const dd of p.chain.dos) await bump('delivery_order_items', dd);
        if (p.oldKey !== p.newKey) {
          for (const table of ['inventory_lots', 'inventory_movements', 'inventory_lot_consumptions']) {
            const res = await t.unsafe(
              `UPDATE scm.${table} SET variant_key = $1
                WHERE company_id = $2 AND item_code = $3 AND coalesce(variant_key,'') = $4`,
              [p.newKey, CO, p.itemCode, p.oldKey]);
            stockMoved += Number(res.count ?? 0);
          }
        }
      });
    }
    line(`APPLIED — ${docLines} document line(s), ${stockMoved} stock row(s) re-keyed.`);

    /* VERIFY on a FRESH connection, asserting the SHAPE. */
    const check = postgres(DST, { ssl: 'require', max: 1, prepare: false });
    try {
      const bad = [];
      for (const p of writable) {
        const [row] = await check`SELECT variants FROM scm.purchase_order_items WHERE id = ${p.poItemId}`;
        const now = new Set(((row?.variants ?? {}).specials ?? []).map(String));
        const missed = p.add.filter((a) => !now.has(a));
        if (missed.length) bad.push(`${p.poNumber} ${p.itemCode}: still missing ${missed.join(', ')}`);
        if (p.oldKey !== p.newKey) {
          const left = Number((await check.unsafe(
            `SELECT count(*)::int AS n FROM scm.inventory_lots WHERE company_id=$1 AND item_code=$2 AND coalesce(variant_key,'')=$3`,
            [CO, p.itemCode, p.oldKey]))[0]?.n ?? 0);
          if (left) bad.push(`${p.poNumber} ${p.itemCode}: ${left} lot(s) left in the old bucket`);
        }
      }
      if (bad.length) { line(`VERIFY FAILED — ${bad.length}: ${bad.slice(0, 8).join(' · ')}`); process.exitCode = 1; }
      else line(`VERIFY OK — ${writable.length} line(s) carry the supplier's options, re-read on a fresh connection.`);
    } finally {
      await check.end({ timeout: 5 });
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}
