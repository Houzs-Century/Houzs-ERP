#!/usr/bin/env node
/* cost-zero-cutover-lots-2026-09-09 — give every zero-cost cutover stock lot a
 * unit cost, taken from AutoCount, so a sales invoice raised against it carries
 * a COGS.
 *
 * Owner, 2026-09-09: 「Costing 一定要有，因为要不然的话，我开 SCM 就 capture 不到
 * COGS」. Measured on production the same day: 403 of the 10,336 units on hand
 * (3.9%) carry `unit_cost_sen = 0`, across 277 lots and 132 item codes, and
 * every one arrived through `source_doc_type = 'AC_CUTOVER'` — the migration
 * imported a quantity and no cost.
 *
 * ── THE SOURCE IS AUTOCOUNT, ON THE OWNER'S INSTRUCTION ────────────────────
 * 「通过 AutoCount 的通道去查看整个计算 … 通过那边去提取，得到准确的 costing。
 * 要不然我的 COGS 和开 Invoice 全部都不对了」.
 *
 * `backend/scripts/data/ac-item-costs.json` is that extraction: the
 * movement-weighted average cost of every item in the book's own stock ledger
 * (`StockDTL`, positive-quantity rows only — those are the receipts that carry a
 * cost). 911 items, exported over ZeroTier because THIS RUNNER CANNOT REACH THE
 * BOOK: AutoCount is on the office LAN and a GitHub runner has no ZeroTier. The
 * file is the same pattern as `data/ac-convert-edges.json.gz` and every other
 * book snapshot in this directory.
 *
 * ── WHY OUR OWN PURCHASE ORDERS ARE THE WRONG SOURCE, MEASURED ─────────────
 * The first version of this script derived the cost from our purchase orders and
 * was wrong twice over. A sofa PO carries the WHOLE sofa's money on ONE
 * compartment line and RM 0 on the rest — `HC-PO-008783` reads
 * `9058-1NA=0 | 9058-1A(RHF)=0 | 9058-CNR=0 | 9058-1NA=0 | 9058-2A(LHF)=4215` —
 * so averaging per compartment code reads a whole sofa as the price of one
 * piece. And summing money and weight across ALL purchase orders came out **6x
 * too low**, because the orders whose sofa carries no price contribute weight
 * and no money. The book says a 9058 sofa costs RM 2,278; our POs implied
 * RM 4,215. The book wins.
 *
 * ── HOW A SOFA COMPARTMENT IS PRICED ───────────────────────────────────────
 * The book prices a SOFA; we hold COMPARTMENTS, because a sofa is one line there
 * and one row per compartment here. So:
 *
 *     compartment cost = book's whole-sofa cost
 *                        ÷ that model's TYPICAL BUILD WEIGHT
 *                        × this compartment's weight
 *
 *   · the weight is `scm.compartment_library.default_price` — the owner's own
 *     price list, read at run time, never hardcoded. Owner: 「乙 你根据我们目前的
 *     价格的比例大概去算就行」.
 *   · the TYPICAL BUILD WEIGHT is measured from real sales, not invented: our
 *     sales-order compartment rows grouped by `linked_ac_dtlkey` — one book line
 *     IS one sofa — then the median total weight per model. Measured: 8030 over
 *     120 real sofas is 3,480; 9058 over 92 is 4,965.
 *   · so the pieces of one typical sofa sum back to the book's cost for that
 *     sofa. The books balance rather than being made to look balanced.
 *
 * Worked, from the live data: 9058 = RM 2,278.00 / 4,965 x 1490 = RM 683.60 for
 * a 1-seater; 8030 = RM 1,877.68 / 3,480 x 1490 = RM 803.90.
 *
 * ── WHAT STAYS AT ZERO, AND IS REPORTED RATHER THAN GUESSED ────────────────
 * Items the book has never costed, sofa models with no book item at all (1025,
 * 2376, 2379, 2391, 5142, 5150, 7179, 7219, 7226, 7233), and the `-1S` / `-2S`
 * whole-sofa codes, which are not a compartment and have no weight. Owner:
 * 「如果没有 variant，那就算了」 — the same applies to a cost nothing supports.
 * Inventing one would put a figure in the accounts that no document backs.
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
 *   this run costed is still zero, no negative cost exists anywhere, the lot
 *   count is unchanged, and the costed count rose by exactly what was written.
 *   A row count alone would pass on a run that costed the wrong lots.
 *
 * RE-RUN: idempotent — a second run finds them costed and reports 0.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *       COMPANY_ID (default 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'cost zero cutover lots 2026-09-09';
const APPLY = MODE === 'apply';
const CO = Number(process.env.COMPANY_ID || 1);
const here = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(here, 'data', 'ac-item-costs.json');

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
const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
const bookCost = new Map(Object.entries(snap.items).map(([k, v]) => [k.trim().toUpperCase(), v]));

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

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
  console.log(`MODE=${MODE}  company ${CO}`);
  console.log(`AutoCount extraction: ${Object.keys(snap.items).length} item(s), exported ${snap.exported_at}`);

  const lib = (await sql`
    SELECT label, default_price::int AS price FROM scm.compartment_library
     WHERE company_id = ${CO} AND coalesce(default_price,0) > 0`)
    .map((r) => ({ label: r.label, price: r.price }));
  console.log(`price list: ${lib.length} compartment type(s)`);

  /* THIRD SOURCE, non-sofa only: what we actually paid.
     The owner approved it (2026-09-09) once the book's own coverage was shown to
     stop at 223 of 403 units. A MATTRESS purchase order prices one line per
     mattress, so its unit price is a real per-unit cost and carries none of the
     sofa trap this file's header describes — a sofa's whole price sits on ONE
     compartment line, which is why sofas are excluded here and priced from the
     book instead. Weighted by quantity over PRICED lines only, so an unpriced
     line cannot drag the average down. */
  const poPrice = new Map();
  for (const r of await sql`
    SELECT p.item_code,
           sum(p.qty * p.unit_price_sen)::numeric AS value_sen,
           sum(p.qty)::numeric AS qty
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
     WHERE ph.company_id = ${CO} AND ph.status NOT IN ('CANCELLED','DRAFT')
       AND coalesce(p.unit_price_sen,0) > 0 AND p.qty > 0
       AND p.item_code !~ '^[0-9]{4}-'
     GROUP BY p.item_code`) {
    const q = Number(r.qty);
    if (q > 0) poPrice.set(r.item_code.trim().toUpperCase(), Math.round(Number(r.value_sen) / q));
  }
  console.log(`our purchase history: ${poPrice.size} non-sofa item(s) with a real unit price`);

  /* TYPICAL BUILD WEIGHT, from real sales. One book line IS one sofa. */
  const soRows = await sql`
    SELECT i.linked_ac_dtlkey::text AS key, split_part(i.item_code,'-',1) AS model,
           i.item_code, i.qty::numeric AS qty
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} AND i.linked_ac_dtlkey IS NOT NULL
       AND i.item_code ~ '^[0-9]{4}-' AND coalesce(i.cancelled,false) = false`;
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

  /* model -> the book's sofa items carrying that model number */
  const modelCost = new Map();
  for (const m of buildWeight.keys()) {
    const hits = [...bookCost.entries()].filter(([k]) => k.includes('SOFA') && k.includes(m));
    if (!hits.length) continue;
    const q = hits.reduce((a, [, v]) => a + v.qty_in, 0);
    const c = hits.reduce((a, [, v]) => a + v.qty_in * v.avg_cost_sen, 0) / q;
    modelCost.set(m, { sen: c, items: hits.map(([k]) => k) });
  }
  console.log('\n=== per-model rate, from the book ===');
  for (const [m, mc] of [...modelCost].sort()) {
    const bw = buildWeight.get(m);
    console.log(`  ${m}  book RM ${(mc.sen / 100).toFixed(2).padStart(9)}`
      + `  / build ${String(bw).padStart(5)}  -> 1-seater RM ${((mc.sen / bw) * 1490 / 100).toFixed(2)}`
      + `   [${mc.items.join(', ')}]`);
  }

  const lots = await sql`
    SELECT id, item_code, qty_remaining::numeric AS qty
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND qty_remaining > 0 AND coalesce(unit_cost_sen,0) = 0
     ORDER BY item_code`;

  const plan = [];
  const left = new Map();
  for (const l of lots) {
    const up = l.item_code.trim().toUpperCase();
    let sen = null;
    let why = null;
    if (bookCost.has(up)) {
      sen = bookCost.get(up).avg_cost_sen;
      why = 'book item cost';
    } else if (/^[0-9]{4}-/.test(l.item_code)) {
      const m = l.item_code.slice(0, l.item_code.indexOf('-'));
      const w = weightOf(l.item_code, lib);
      const mc = modelCost.get(m);
      const bw = buildWeight.get(m);
      if (mc && w && bw) {
        sen = Math.round((mc.sen / bw) * w);
        why = 'sofa share of the book cost';
      }
    }
    if ((!sen || sen <= 0) && !/^[0-9]{4}-/.test(l.item_code) && poPrice.has(up)) {
      sen = poPrice.get(up);
      why = 'what we paid (purchase order)';
    }
    if (!sen || sen <= 0) {
      const k = /^[0-9]{4}-/.test(l.item_code)
        ? 'sofa: the book has no cost for this model, or the piece has no weight'
        : 'not a sofa: neither the book nor our own purchase history has a price';
      const d = left.get(k) ?? { units: 0, codes: new Set() };
      d.units += Number(l.qty); d.codes.add(l.item_code);
      left.set(k, d);
      continue;
    }
    plan.push({ id: l.id, code: l.item_code, qty: Number(l.qty), sen, why });
  }

  const byCode = new Map();
  for (const p of plan) {
    const d = byCode.get(p.code) ?? { units: 0, sen: p.sen, why: p.why };
    d.units += p.qty;
    byCode.set(p.code, d);
  }
  console.log('\n=== WOULD COST ===');
  for (const [code, d] of [...byCode].sort((a, b) => b[1].units - a[1].units)) {
    console.log(`  ${code.padEnd(24)} ${String(d.units).padStart(4)} unit(s)`
      + `  RM ${(d.sen / 100).toFixed(2).padStart(9)} each  [${d.why}]`);
  }
  const units = plan.reduce((a, p) => a + p.qty, 0);
  const value = plan.reduce((a, p) => a + p.qty * p.sen, 0);
  console.log(`\n  ${plan.length} lot(s), ${units} unit(s), inventory value +RM ${(value / 100).toFixed(2)}`);
  console.log('\n  LEFT AT ZERO, reported not guessed:');
  for (const [k, d] of left) {
    console.log(`    ${String(d.units).padStart(4)} unit(s), ${d.codes.size} code(s) — ${k}`);
    console.log(`        ${[...d.codes].slice(0, 10).join(', ')}${d.codes.size > 10 ? ' …' : ''}`);
  }

  if (!APPLY) {
    console.log('\nPLAN ONLY — nothing was written.');
    await sql.end();
    process.exit(0);
  }

  const [before] = await sql`
    SELECT count(*) FILTER (WHERE coalesce(unit_cost_sen,0) > 0)::int AS costed,
           count(*)::int AS lots
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;

  let wrote = 0;
  for (const p of plan) {
    const done = await sql`
      UPDATE scm.inventory_lots SET unit_cost_sen = ${p.sen}
       WHERE id = ${p.id} AND coalesce(unit_cost_sen,0) = 0
      RETURNING id`;
    wrote += done.length;
  }
  console.log(`\nAPPLIED: ${wrote} lot(s) costed.`);
  await sql.end();

  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [after] = await check`
    SELECT count(*) FILTER (WHERE coalesce(unit_cost_sen,0) > 0)::int AS costed,
           count(*) FILTER (WHERE unit_cost_sen < 0)::int AS negative,
           count(*)::int AS lots,
           coalesce(sum(qty_remaining * coalesce(unit_cost_sen,0)),0)::bigint AS value_sen
      FROM scm.inventory_lots WHERE company_id = ${CO} AND qty_remaining > 0`;
  const [stillZero] = await check`
    SELECT count(*)::int AS n FROM scm.inventory_lots
     WHERE id = ANY(${plan.map((p) => p.id)}) AND coalesce(unit_cost_sen,0) = 0`;
  await check.end();

  const ok = {
    'no lot this run costed is still zero': stillZero.n === 0,
    'no negative cost anywhere': after.negative === 0,
    'lot count unchanged': after.lots === before.lots,
    'costed lots rose by exactly what was written': after.costed === before.costed + wrote,
  };
  console.log('\n=== VERIFY (fresh connection) ===');
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    console.log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  console.log(`  costed lots ${before.costed} -> ${after.costed} of ${after.lots}`);
  console.log(`  inventory value now RM ${(Number(after.value_sen) / 100).toFixed(2)}`);
  if (bad) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK — every unit the book could price now carries a COGS.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
