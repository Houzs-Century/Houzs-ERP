#!/usr/bin/env node
/* cost-zero-cutover-lots-2026-09-09 — give every zero-cost cutover stock lot a
 * unit cost, taken from AutoCount, so a sales invoice raised against it carries
 * a COGS.
 *
 * Owner, 2026-09-09: 「Costing 一定要有，因为要不然的话，我开 SCM 就 capture 不到
 * COGS」, and on the source 「通过 AutoCount 的通道去查看整个计算 … 通过那边去提取，
 * 得到准确的 costing。要不然我的 COGS 和开 Invoice 全部都不对了」.
 *
 * ── THIS IS A FIFO LEDGER, SO THE ANSWER IS A RECEIPT, NEVER AN AVERAGE ────
 * The version before this one costed each lot at the item's movement-weighted
 * AVERAGE. The owner refused it in five words — 「不是跟着FIFO的嘛？」 — and he
 * is right, and it is not a rounding argument. Every `scm.inventory_lots` row
 * carries its OWN `unit_cost_sen` and consumption walks oldest-first; the Stock
 * Breakdown screen says so on its face ("STOCK LOTS (OLDEST FIRST — CONSUMED
 * FIRST ON THE NEXT DO)"). One blended number written onto every lot flattens
 * the layers, so you sell the old cheap stock and the system books the
 * expensive cost.
 *
 * Measured on the book: `AMN-SF9058 SOFA` was received at RM 1,210 (2026-08-13),
 * RM 1,710 (08-19) and RM 3,040 (08-26) — a 2.5x spread on one model inside two
 * weeks — and carries 42 distinct costs across its layers. `DSL-8030 SOFA` has
 * 81 across 289. An average matches no actual receipt. An average answers "what
 * does this item usually cost"; a COGS is "what did THESE units cost".
 *
 * NOTHING WAS APPLIED under the average method. This file is the replacement.
 *
 * ── WHERE THE NUMBER COMES FROM, IN ORDER ─────────────────────────────────
 * `data/ac-stock-receipts-2026-09-09.json.gz` is every stock RECEIPT in the book
 * — `StockDTL` rows with `Qty > 0`, each carrying its own FIFO layer cost from
 * `FIFOCost` and its receipt document number. 26,342 receipts, 23,143 of them
 * priced, 911 of 956 items with at least one priced receipt. It is committed
 * because THIS RUNNER CANNOT REACH THE BOOK: AutoCount is on the office LAN and
 * a GitHub runner has no ZeroTier.
 *
 *  1. THE LOT'S OWN RECEIPT. Our cutover lots were relayered out of the book's
 *     receipt history and each one's movement note records the document —
 *     `AC GR GR-004679 2026-05-28`. That is the exact layer, so its cost is the
 *     lot's cost. This is FIFO with no interpretation at all.
 *  2. THE BOOK'S NEAREST PRICED RECEIPT of the same item to the lot's own
 *     received date. A lot with no note still has a date; the closest real
 *     receipt is the closest real answer, and it is still an actual layer.
 *  3. SOFA: the whole-sofa cost from the book, split across compartments. The
 *     book prices a SOFA and we hold COMPARTMENTS, because a sofa is one line
 *     there and one row per compartment here — see the split below.
 *  4. NON-SOFA: what we actually paid, from our own purchase orders. The owner
 *     approved this fallback (2026-09-09, 「照算」) once the book's coverage was
 *     shown to stop short. A mattress PO prices one line per mattress, so its
 *     unit price is a real per-unit cost; a sofa PO does not, which is why sofas
 *     are excluded from it.
 *
 * ── HOW A SOFA COMPARTMENT IS PRICED ───────────────────────────────────────
 *     compartment cost = the book's whole-sofa cost (a real receipt, step 2's
 *                        nearest-dated rule applied to the book's sofa item)
 *                        ÷ that model's TYPICAL BUILD WEIGHT
 *                        × this compartment's weight
 *
 *   · the weight is `scm.compartment_library.default_price` — the owner's own
 *     price list, read at run time, never hardcoded. Owner: 「乙 你根据我们目前的
 *     价格的比例大概去算就行」.
 *   · the TYPICAL BUILD WEIGHT is measured from real sales, not invented: our
 *     sales-order compartment rows grouped by `linked_ac_dtlkey` — one book line
 *     IS one sofa — then the median total weight per model.
 *   · so the pieces of one typical sofa sum back to the book's cost for that
 *     sofa. The books balance rather than being made to look balanced.
 *
 * ── WHY OUR OWN PURCHASE ORDERS ARE NOT THE FIRST SOURCE, MEASURED ────────
 * An earlier version derived everything from our purchase orders and was wrong
 * twice over. A sofa PO carries the WHOLE sofa's money on ONE compartment line
 * and RM 0 on the rest — `HC-PO-008783` reads `9058-1NA=0 | 9058-1A(RHF)=0 |
 * 9058-CNR=0 | 9058-1NA=0 | 9058-2A(LHF)=4215` — so averaging per compartment
 * code reads a whole sofa as the price of one piece. And summing money and
 * weight across ALL purchase orders came out 6x too low, because the orders
 * whose sofa carries no price contribute weight and no money.
 *
 * ── WHAT STAYS AT ZERO, AND IS REPORTED RATHER THAN GUESSED ────────────────
 * A lot the book never priced, a sofa model with no priced book receipt, and the
 * `-1S` / `-2S` whole-sofa codes, which are not a compartment and have no
 * weight. Owner: 「如果没有 variant，那就算了」 — the same applies to a cost
 * nothing supports. Inventing one puts a figure in the accounts that no
 * document backs.
 *
 * ── WHAT THIS CHANGES ──────────────────────────────────────────────────────
 * It RAISES inventory value — those units are currently carried at nothing,
 * which is the whole problem. It writes ONE column, `unit_cost_sen`, only on
 * lots whose value is currently 0, so nothing already costed moves. No journal
 * entry, no stock movement, no quantity.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every item code and the totals.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE carries `coalesce(unit_cost_sen,0) = 0`, so a lot costed since
 *   this was measured is skipped, never overwritten.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: no lot
 *   this run costed is still zero, no negative or absurd cost exists anywhere,
 *   the lot count and quantities are unchanged, and the costed count rose by
 *   exactly what was written. A row count alone would pass on a run that costed
 *   the wrong lots.
 *
 * RE-RUN: idempotent — a second run finds them costed and reports 0 to write.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { readMappingCsv, normCode } from './lib/ac-mapping-csv.mjs';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'cost zero cutover lots 2026-09-09';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, 'data', 'ac-stock-receipts-2026-09-09.json.gz');
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}
if (!fs.existsSync(SNAP)) {
  console.error(`REFUSED: ${SNAP} is missing. It is the AutoCount extraction and `
    + 'this runner cannot reach the book itself. Nothing was written.');
  process.exit(1);
}
const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8').replace(/^﻿/, ''));
const norm = normCode;

/* THE BOOK'S ITEM CODE IS NOT OURS. `HOK-1007 (K)` in AutoCount is `CODY-(K)`
   here, and 815 of the 949 mapped receipt items differ that way. Indexing under
   the book's own code would match almost nothing while failing silently — every
   lot would report "the book has no price for this item" and read as a data
   gap. Read through the shared RFC4180 reader because three mattress names
   carry a quoted inch mark a naive split(",") cuts in half. */
const MAP = path.join(here, 'data', 'autocount-erp-mapping-1561.csv');
const acToErp = readMappingCsv(fs.readFileSync(MAP, 'utf8'));
const erpCodeOf = (acCode) => norm(acToErp.get(norm(acCode))?.erp || acCode);

/** Every priced receipt, indexed by (document, ERP item code) and by ERP code. */
const byDoc = new Map();
const pricedByItem = new Map();
for (const r of snap.receipts) {
  if (!(r.cost_sen > 0)) continue;
  const k = erpCodeOf(r.item);
  if (r.doc_no) byDoc.set(`${norm(r.doc_no)} ${k}`, r);
  if (!pricedByItem.has(k)) pricedByItem.set(k, []);
  pricedByItem.get(k).push(r);
}
for (const v of pricedByItem.values()) v.sort((a, b) => (a.date < b.date ? -1 : 1));

const NOTE_RE = /^AC\s+(\w+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2})\s*$/i;
const dayOf = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() : null);

/** The book's priced receipt of `code` closest in time to `when`. */
function nearestReceipt(code, when) {
  const rs = pricedByItem.get(code);
  if (!rs || !rs.length) return null;
  const t = dayOf(when);
  if (t == null) return rs[rs.length - 1];
  let best = rs[0];
  let bestGap = Math.abs(dayOf(best.date) - t);
  for (const r of rs) {
    const g = Math.abs(dayOf(r.date) - t);
    if (g < bestGap) { best = r; bestGap = g; }
  }
  return best;
}

const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });

/** compartment token -> the owner's price-list weight. */
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

try {
  log(`MODE=${MODE}  company ${CO}`);
  log(`AutoCount extraction: ${snap.receipts.length} receipt(s), ${byDoc.size} priced and `
    + `addressable by document, ${pricedByItem.size} item(s) with a priced receipt; `
    + `exported ${snap.exported_at}`);

  const lib = (await sql`
    SELECT label, default_price::int AS price FROM scm.compartment_library
     WHERE company_id = ${CO} AND coalesce(default_price, 0) > 0`)
    .map((r) => ({ label: r.label, price: r.price }));
  log(`price list: ${lib.length} compartment type(s)`);

  /* Non-sofa only: what we actually paid. Weighted by quantity over PRICED
     lines only, so an unpriced line cannot drag the figure down. */
  const poPrice = new Map();
  for (const r of await sql`
    SELECT p.item_code,
           sum(p.qty * p.unit_price_sen)::numeric AS value_sen,
           sum(p.qty)::numeric AS qty
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
     WHERE ph.company_id = ${CO} AND ph.status NOT IN ('CANCELLED', 'DRAFT')
       AND coalesce(p.unit_price_sen, 0) > 0 AND p.qty > 0
       AND p.item_code !~ '^[0-9]{4}-'
     GROUP BY p.item_code`) {
    const q = Number(r.qty);
    if (q > 0) poPrice.set(norm(r.item_code), Math.round(Number(r.value_sen) / q));
  }
  log(`our purchase history: ${poPrice.size} non-sofa item(s) with a real unit price`);

  /* TYPICAL BUILD WEIGHT, from real sales. One book line IS one sofa. */
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

  /* model -> the book's SOFA item codes carrying that model number. The RATE is
     not precomputed: it is resolved per lot, from the receipt nearest that
     lot's own date, so two lots of one model received months apart do not get
     the same blended number. */
  /* The sheet folds a whole book sofa onto our BASE code — `AMN-SF9058 SOFA`
     becomes `9058-1S` — so a model's book receipts are the indexed codes whose
     model number matches. Matching on the substring "SOFA" would find nothing:
     after the translation these keys are ERP codes and none of them spells it. */
  const modelItems = new Map();
  for (const m of buildWeight.keys()) {
    const hits = [...pricedByItem.keys()].filter((k) => k.split('-')[0] === m);
    if (hits.length) modelItems.set(m, hits);
  }
  function sofaBookCost(model, when) {
    const codes = modelItems.get(model);
    if (!codes) return null;
    let best = null;
    let bestGap = Infinity;
    const t = dayOf(when);
    for (const c of codes) {
      const r = nearestReceipt(c, when);
      if (!r) continue;
      const g = t == null ? 0 : Math.abs(dayOf(r.date) - t);
      if (g < bestGap) { best = r; bestGap = g; }
    }
    return best;
  }

  const lots = await sql`
    SELECT l.id, l.item_code, l.qty_remaining::numeric AS qty,
           l.received_at::date AS at, m.notes
      FROM scm.inventory_lots l
      LEFT JOIN scm.inventory_movements m ON m.id = l.movement_id
     WHERE l.company_id = ${CO} AND l.qty_remaining > 0
       AND coalesce(l.unit_cost_sen, 0) = 0
     ORDER BY l.item_code, l.received_at`;
  log(`lots on hand with no cost: ${lots.length}`);

  const plan = [];
  const left = new Map();
  for (const l of lots) {
    const up = norm(l.item_code);
    const isSofa = /^[0-9]{4}-/.test(l.item_code);
    let sen = null;
    let why = null;

    const m = NOTE_RE.exec(String(l.notes ?? '').trim());
    if (m) {
      const r = byDoc.get(`${norm(m[2])} ${up}`);
      if (r) { sen = r.cost_sen; why = `its own receipt in the book (${r.doc_no} ${r.date})`; }
    }
    if (!sen && !isSofa) {
      const r = nearestReceipt(up, l.at);
      if (r) { sen = r.cost_sen; why = `the book's nearest receipt of this item (${r.doc_no ?? r.doc_type} ${r.date})`; }
    }
    if (!sen && isSofa) {
      const model = l.item_code.slice(0, l.item_code.indexOf('-'));
      const w = weightOf(l.item_code, lib);
      const bw = buildWeight.get(model);
      const r = sofaBookCost(model, l.at);
      if (r && w && bw) {
        sen = Math.round((r.cost_sen / bw) * w);
        why = `sofa share of the book's ${r.item} at ${r.date} (RM ${(r.cost_sen / 100).toFixed(2)} / ${bw} x ${w})`;
      }
    }
    if (!sen && !isSofa && poPrice.has(up)) {
      sen = poPrice.get(up);
      why = 'what we paid (purchase order)';
    }
    if (!sen || sen <= 0) {
      const k = isSofa
        ? 'sofa: the book has no priced receipt for this model, or the piece has no weight'
        : 'not a sofa: neither the book nor our own purchase history has a price';
      const d = left.get(k) ?? { units: 0, codes: new Set() };
      d.units += Number(l.qty); d.codes.add(l.item_code);
      left.set(k, d);
      continue;
    }
    plan.push({ id: l.id, code: l.item_code, qty: Number(l.qty), sen, why });
  }

  log('\n=== WOULD COST ===');
  for (const p of [...plan].sort((a, b) => b.qty - a.qty)) {
    log(`  ${p.code.padEnd(24)} ${String(p.qty).padStart(4)} unit(s)`
      + `  RM ${(p.sen / 100).toFixed(2).padStart(9)} each`);
    log(`      ${p.why}`);
  }
  const units = plan.reduce((a, p) => a + p.qty, 0);
  const value = plan.reduce((a, p) => a + p.qty * p.sen, 0);
  log(`\n  ${plan.length} lot(s), ${units} unit(s), inventory value +RM ${(value / 100).toFixed(2)}`);
  log('\n  LEFT AT ZERO, reported not guessed:');
  for (const [k, d] of left) {
    log(`    ${String(d.units).padStart(4)} unit(s), ${d.codes.size} code(s) — ${k}`);
    log(`        ${[...d.codes].slice(0, 10).join(', ')}${d.codes.size > 10 ? ' …' : ''}`);
  }

  if (!APPLY) {
    log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [before] = await sql`
    SELECT count(*) FILTER (WHERE coalesce(unit_cost_sen, 0) > 0)::int AS costed,
           count(*)::int AS lots,
           coalesce(sum(qty_remaining), 0)::numeric AS qty
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;

  let wrote = 0;
  for (const p of plan) {
    const done = await sql`
      UPDATE scm.inventory_lots SET unit_cost_sen = ${p.sen}
       WHERE id = ${p.id} AND coalesce(unit_cost_sen, 0) = 0
      RETURNING id`;
    wrote += done.length;
  }
  log(`\nAPPLIED: ${wrote} lot(s) costed.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1, prepare: false });
  const [after] = await check`
    SELECT count(*) FILTER (WHERE coalesce(unit_cost_sen, 0) > 0)::int AS costed,
           count(*) FILTER (WHERE unit_cost_sen < 0)::int AS negative,
           count(*) FILTER (WHERE unit_cost_sen > 10000000)::int AS absurd,
           count(*)::int AS lots,
           coalesce(sum(qty_remaining), 0)::numeric AS qty,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen, 0)), 0)::bigint AS value_sen
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  const [stillZero] = await check`
    SELECT count(*)::int AS n FROM scm.inventory_lots
     WHERE id = ANY(${plan.map((p) => p.id)}) AND coalesce(unit_cost_sen, 0) = 0`;
  await check.end();

  const ok = {
    'no lot this run costed is still zero': stillZero.n === 0,
    'no negative cost anywhere': after.negative === 0,
    'no lot priced above RM 100,000 a unit': after.absurd === 0,
    'lot count unchanged': after.lots === before.lots,
    'quantities unchanged': String(after.qty) === String(before.qty),
    'costed lots rose by exactly what was written': after.costed === before.costed + wrote,
  };
  log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  log(`  costed lots ${before.costed} -> ${after.costed} of ${after.lots}`);
  log(`  inventory value now RM ${(Number(after.value_sen) / 100).toFixed(2)}`);
  if (bad) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  log('VERIFY OK — every unit the book could price now carries a COGS.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
