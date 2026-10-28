#!/usr/bin/env node
/* diag-zero-cost-lots-remaining — why does each stock lot still carry no cost?
 *
 * WHY THIS EXISTS. `cost-zero-cutover-lots-2026-09-09.mjs` costed 34 of the 277
 * zero-cost lots on 2026-09-09 (run 34374384637) and reported the rest in two
 * lines: "228 unit(s), 81 code(s) — sofa: the book has no priced receipt for
 * this model, OR the piece has no weight" and "115 unit(s), 17 code(s) — not a
 * sofa: neither the book nor our own purchase history has a price". The owner
 * wants the coverage as close to complete as it can honestly get
 * (「你尽量把所有的东西都补齐吧」), and those two sentences do not say what is
 * actually missing — each folds several different causes into one line, so
 * neither can be acted on.
 *
 * A summary that names two possibilities is not a diagnosis. This separates
 * them, per lot, and says which source WOULD answer:
 *
 *   the book, by this lot's own receipt document
 *   the book, by any priced receipt of this item
 *   sofa: is the model's build weight known (from our real sales)?
 *   sofa: does this compartment have a weight in the owner's price list?
 *   sofa: does the book price this model at all?
 *   sofa: do OUR purchase orders carry money anywhere on this model?
 *   non-sofa: does our own purchase history price this code?
 *
 * READ-ONLY: SELECTs only, no DDL, no writes, no transaction. Every legitimate
 * answer exits 0 — the answer is the output, not the exit code.
 *
 * RE-RUN: read-only, so a second run changes nothing and reports the same
 * unless the data moved.
 *
 * Env: DATABASE_URL (required)   COMPANY_ID (default 1)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readMappingCsv, normCode } from './lib/ac-mapping-csv.mjs';

const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const SNAP = path.join(here, 'data', 'ac-stock-receipts-2026-09-09.json.gz');
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing — it is the AutoCount extraction.`);
  process.exit(1);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8').replace(/^﻿/, ''));
const norm = normCode;
const acToErp = readMappingCsv(fs.readFileSync(path.join(here, 'data', 'autocount-erp-mapping-1561.csv'), 'utf8'));
const erpCodeOf = (ac) => norm(acToErp.get(norm(ac))?.erp || ac);

const byDoc = new Map();
const pricedByItem = new Map();
for (const r of snap.receipts) {
  if (!(r.cost_sen > 0)) continue;
  const k = erpCodeOf(r.item);
  if (r.doc_no) byDoc.set(`${norm(r.doc_no)} ${k}`, r);
  if (!pricedByItem.has(k)) pricedByItem.set(k, []);
  pricedByItem.get(k).push(r);
}
const NOTE_RE = /^AC\s+(\w+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;

/** compartment token -> the owner's price-list weight. Same rules as the
 *  costing script; kept here so the diagnosis matches what that script does. */
function weightOf(code, lib) {
  const comp = (code.includes('-') ? code.slice(code.indexOf('-') + 1) : code).toUpperCase();
  const by = (re) => lib.find((r) => re.test(r.label.toUpperCase()))?.price ?? null;
  if (/^2NA/.test(comp)) return by(/2NA/);
  if (/^1NA/.test(comp)) return by(/1NA/);
  if (/^2A|^2B/.test(comp)) return by(/^2A/);
  if (/^1A|^1B/.test(comp)) return by(/^1A/);
  if (/^CNR|CORNER/.test(comp)) return by(/CORNER/);
  if (/CONSOLE/.test(comp)) return by(/CONSOLE/);
  if (/STOOL|OTTOMAN/.test(comp)) return by(/STOOL|OTTOMAN/);
  if (/^L[\s(-]|^L$/.test(comp)) return by(/^L /);
  return null;
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

try {
  log(`company ${CO}`);
  log(`book receipts priced: ${snap.receipts.filter((r) => r.cost_sen > 0).length}; `
    + `ERP codes with a priced receipt: ${pricedByItem.size}`);

  const lib = (await sql`
    SELECT label, default_price::int AS price FROM scm.compartment_library
     WHERE company_id = ${CO} AND coalesce(default_price, 0) > 0`)
    .map((r) => ({ label: r.label, price: r.price }));
  log(`compartment price list: ${lib.length} type(s) — ${lib.map((r) => r.label).join(', ')}`);

  /* Our own purchase history, per item code, priced lines only. */
  const poPrice = new Map();
  for (const r of await sql`
    SELECT p.item_code, sum(p.qty * p.unit_price_sen)::numeric AS value_sen,
           sum(p.qty)::numeric AS qty
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
     WHERE ph.company_id = ${CO} AND ph.status NOT IN ('CANCELLED', 'DRAFT')
       AND coalesce(p.unit_price_sen, 0) > 0 AND p.qty > 0
     GROUP BY p.item_code`) {
    const q = Number(r.qty);
    if (q > 0) poPrice.set(norm(r.item_code), Math.round(Number(r.value_sen) / q));
  }
  log(`our purchase history: ${poPrice.size} item code(s) with a real unit price`);

  /* WHOLE-SOFA money from OUR purchase orders. A sofa PO puts the money on one
     compartment line and RM 0 on the rest, so the sofa's price is the SUM over
     the PO's lines for that model, never the per-line average. Grouped by
     (purchase order, model) because that is the grain a sofa is ordered at. */
  const sofaPo = new Map();
  for (const r of await sql`
    SELECT p.purchase_order_id AS po, split_part(p.item_code, '-', 1) AS model,
           sum(p.qty * p.unit_price_sen)::numeric AS value_sen,
           max(p.qty)::numeric AS units
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
     WHERE ph.company_id = ${CO} AND ph.status NOT IN ('CANCELLED', 'DRAFT')
       AND p.item_code ~ '^[0-9]{4}-'
     GROUP BY 1, 2
    HAVING sum(p.qty * p.unit_price_sen) > 0`) {
    const m = String(r.model);
    if (!sofaPo.has(m)) sofaPo.set(m, []);
    sofaPo.get(m).push(Math.round(Number(r.value_sen) / Math.max(1, Number(r.units))));
  }
  log(`our purchase history: ${sofaPo.size} sofa model(s) with money on a purchase order`);

  /* Build weight per model, from real sales. */
  const soRows = await sql`
    SELECT i.linked_ac_dtlkey::text AS key, split_part(i.item_code, '-', 1) AS model,
           i.item_code, i.qty::numeric AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey IS NOT NULL
       AND i.item_code ~ '^[0-9]{4}-' AND coalesce(i.cancelled, false) = false`;
  const perSofa = new Map();
  for (const r of soRows) {
    const w = weightOf(r.item_code, lib);
    if (!w) continue;
    const k = `${r.key}|${r.model}`;
    perSofa.set(k, (perSofa.get(k) ?? 0) + w * Number(r.qty));
  }
  const builds = new Map();
  for (const [k, wsum] of perSofa) {
    const model = k.slice(k.indexOf('|') + 1);
    if (!builds.has(model)) builds.set(model, []);
    builds.get(model).push(wsum);
  }
  const buildWeight = new Map([...builds].map(([m, v]) => [m, median(v)]));
  log(`build weight known for ${buildWeight.size} sofa model(s)`);

  const lots = await sql`
    SELECT l.id, l.item_code, l.qty_remaining::numeric AS qty, l.received_at::date AS at,
           l.source_doc_type, l.source_doc_no, m.notes,
           upper(coalesce(p.category::text, '')) AS category
      FROM scm.inventory_lots l
      LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
      LEFT JOIN scm.mfg_products p
             ON upper(p.code) = upper(l.item_code) AND p.company_id = ${CO}
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
       AND coalesce(l.unit_cost_sen, 0) = 0
     ORDER BY l.item_code`;
  log(`\nlots on hand with no cost: ${lots.length}`);

  const reasons = new Map();
  const bump = (k, units) => {
    const e = reasons.get(k) ?? { lots: 0, units: 0, codes: new Set() };
    e.lots += 1; e.units += units; reasons.set(k, e);
    return e;
  };

  const rows = [];
  for (const l of lots) {
    const up = norm(l.item_code);
    const units = Number(l.qty);
    const isSofa = /^[0-9]{4}-/.test(l.item_code);
    const m = NOTE_RE.exec(String(l.notes ?? '').trim());
    const ownReceipt = m ? byDoc.get(`${norm(m[2])} ${up}`) : null;
    const anyPriced = (pricedByItem.get(up) ?? []).length;

    let reason;
    let couldBe = null;
    if (ownReceipt) {
      reason = 'ALREADY COVERED — its own receipt is priced (re-run the costing script)';
    } else if (anyPriced) {
      reason = 'ALREADY COVERED — the book prices this item (re-run the costing script)';
    } else if (isSofa) {
      const model = l.item_code.slice(0, l.item_code.indexOf('-'));
      const w = weightOf(l.item_code, lib);
      const bw = buildWeight.get(model);
      const bookModel = [...pricedByItem.keys()].some((k) => k.split('-')[0] === model);
      if (!w) reason = `sofa: this compartment has no weight in the price list (${l.item_code.slice(l.item_code.indexOf('-') + 1)})`;
      else if (!bw) reason = `sofa: no build weight for model ${model} — we have never sold one with priced compartments`;
      else if (!bookModel) {
        reason = `sofa: the book has never priced model ${model}`;
        const po = sofaPo.get(model);
        if (po && po.length) {
          couldBe = Math.round((median(po) / bw) * w);
          reason += ' — but OUR purchase orders do';
        }
      } else reason = `sofa: model ${model} is priced and weighted — should have been costed`;
    } else if (poPrice.has(up)) {
      reason = 'ALREADY COVERED — our own purchase orders price it (re-run the costing script)';
    } else {
      reason = 'no price anywhere: not in the book, not on any purchase order of ours';
    }
    const e = bump(reason, units);
    e.codes.add(l.item_code);
    rows.push({ code: l.item_code, units, cat: l.category, reason, couldBe, at: l.at });
  }

  log('\n=== WHY EACH LOT IS STILL AT ZERO ===');
  for (const [k, v] of [...reasons].sort((a, b) => b[1].units - a[1].units)) {
    log(`  ${String(v.lots).padStart(4)} lot(s) / ${String(v.units).padStart(5)} unit(s) — ${k}`);
    log(`      ${[...v.codes].slice(0, 12).join(', ')}${v.codes.size > 12 ? ` … (${v.codes.size} codes)` : ''}`);
  }

  const rescuable = rows.filter((r) => r.couldBe > 0);
  const value = rescuable.reduce((a, r) => a + r.units * r.couldBe, 0);
  log(`\n=== SOFA LOTS OUR OWN PURCHASE ORDERS COULD PRICE: ${rescuable.length} lot(s), `
    + `${rescuable.reduce((a, r) => a + r.units, 0)} unit(s), RM ${(value / 100).toFixed(2)} ===`);
  for (const r of rescuable.slice(0, 40)) {
    log(`  ${r.code.padEnd(22)} ${String(r.units).padStart(3)}u  RM ${(r.couldBe / 100).toFixed(2)}`);
  }
  if (rescuable.length > 40) log(`  … ${rescuable.length - 40} more`);

  const dead = rows.filter((r) => r.reason.startsWith('no price anywhere'));
  log(`\n=== NO PRICE ANYWHERE: ${dead.length} lot(s), ${dead.reduce((a, r) => a + r.units, 0)} unit(s) ===`);
  log('  These are the ones that stay at zero unless the owner gives a number.');
  for (const r of dead) log(`  ${r.code.padEnd(34)} ${String(r.units).padStart(3)}u  ${r.cat || '(no category)'}  received ${r.at ?? '-'}`);

  await sql.end();
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
