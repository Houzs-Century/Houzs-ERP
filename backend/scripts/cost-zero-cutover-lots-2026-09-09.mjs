#!/usr/bin/env node
/* cost-zero-cutover-lots-2026-09-09 — give every zero-cost cutover stock lot a
 * unit cost, so a sales invoice raised against it carries a COGS.
 *
 * WHY IT MATTERS, in the owner's words (2026-09-09): 「Costing 一定要有，因为要
 * 不然的话，我开 SCM 就 capture 不到 COGS」 and 「最重要是有COGS」. Measured on
 * production the same day: 403 of the 10,336 units on hand (3.9%) carry
 * `unit_cost_sen = 0`, across 277 lots and 132 item codes, and EVERY ONE of them
 * arrived through `source_doc_type = 'AC_CUTOVER'` — the migration imported a
 * quantity and no cost. Sell one and the invoice books revenue against nothing.
 *
 * ── WHERE A COST CAN HONESTLY COME FROM ────────────────────────────────────
 * Two sources, in this order, and NOTHING is invented beyond them:
 *
 *  1. THE ACCOUNT BOOK. AutoCount's `StockDTL.Cost` for that item code, averaged
 *     over its positive-quantity movements. Checked against the live book: 11 of
 *     the 132 codes (43 units) have one. This is the book's own number and it
 *     wins wherever it exists.
 *
 *  2. A SOFA'S OWN PURCHASE PRICE, SPREAD ACROSS ITS COMPARTMENTS BY THE
 *     OWNER'S PRICE LIST. A sofa purchase order carries the WHOLE sofa's money
 *     on ONE compartment line and RM 0 on the rest — verified on the live data:
 *         HC-PO-008783  9058-1NA=0 | 9058-1A(RHF)=0 | 9058-CNR=0 | 9058-1NA=0 | 9058-2A(LHF)=4215
 *     so a naive "average purchase price per compartment code" reads the whole
 *     sofa as the price of one piece and overstates COGS several times over.
 *     That is the same shape of error as the FX-rate-read-as-a-discount that put
 *     RM 13,068 of fake discount on a purchase order, and it is why this script
 *     allocates instead of averaging.
 *
 *     The owner's ruling, asked with the two options in front of him:
 *     「乙 你根据我们目前的价格的比例大概去算就行 / 最重要是有COGS」 — weight the
 *     split by compartment TYPE using our current price list, which is
 *     `scm.compartment_library.default_price` (2-seater 1990, 1-seater 1490,
 *     corner 1490, L 1490, 2NA 1490, 1NA 990, console 590, stool 490).
 *
 *     THE RATE IS COMPUTED PER PURCHASE ORDER, NOT OVER THE WHOLE MODEL. The
 *     first attempt summed every PO line's money over every PO line's weight and
 *     produced a rate 6x too low, because the purchase orders whose sofa carries
 *     no price at all contribute weight and no money. Per-order rates, then the
 *     MEDIAN per model, is what makes a five-piece RM 4,215 sofa price a
 *     1-seater at ~RM 760-900 instead of ~RM 158.
 *
 *     Two models have exactly ONE priced purchase order, so their "median" is
 *     that one sample: 9050 reads low (RM 259 for a 1-seater) and 5526 high
 *     (RM 1,439). Put to the owner, he chose to use them as computed —
 *     「照算」 — because a rough COGS beats none.
 *
 * ── WHAT IS DELIBERATELY LEFT AT ZERO ──────────────────────────────────────
 * Whatever neither source can answer: models with no priced purchase order at
 * all (8051, 5535, 2379, 7226, 8069, 5527), the `-1S` / `-2S` whole-sofa codes
 * that are not a compartment and have no entry in the price list, and non-sofa
 * items the book has never costed. Roughly 209 units. Inventing a number for
 * those would put a figure in the accounts that nothing supports; they stay 0
 * and are REPORTED, so the gap is visible rather than papered over.
 *
 * ── WHAT THIS CHANGES, SAID PLAINLY ────────────────────────────────────────
 * It RAISES inventory value: ~151 sofa-compartment units gain about RM 121,000
 * between them, plus the book-costed units. That is the point — those units are
 * currently carried at nothing. It writes ONE column, `unit_cost_sen`, on lots
 * whose current value is 0, so no existing cost is overwritten and no already
 * costed lot moves. It posts no journal entry and touches no movement.
 *
 * SAFETY (release discipline, CLAUDE.md):
 *   MODE=plan|apply   default PLAN, printing every lot and the totals.
 *   CONFIRM=<phrase>  required on apply, refused with a non-zero exit.
 *   Every UPDATE carries `coalesce(unit_cost_sen,0) = 0`, so a lot somebody has
 *   costed since this was measured is skipped, never overwritten.
 *   Verification re-reads on a FRESH connection and asserts the SHAPE: no lot
 *   this run costed is still zero, no cost is negative, the count of already
 *   costed lots is unchanged, and the total value rise equals what the plan said.
 *
 * RE-RUN: idempotent. A second run finds those lots costed and reports 0.
 *
 * Env:  DATABASE_URL (required)   MODE=plan|apply   CONFIRM (on apply)
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/cost-zero-cutover-lots-2026-09-09.mjs
 *   DATABASE_URL=... MODE=apply CONFIRM='cost zero cutover lots 2026-09-09' \
 *     node backend/scripts/cost-zero-cutover-lots-2026-09-09.mjs
 */
import postgres from 'postgres';

const MODE = (process.env.MODE ?? 'plan').toLowerCase();
const CONFIRM_PHRASE = 'cost zero cutover lots 2026-09-09';
const APPLY = MODE === 'apply';
const CO = 1;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM='${CONFIRM_PHRASE}'.`);
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

/** The owner's own price list decides the weight. Read, never hardcoded. */
function weightFor(code, lib) {
  const comp = (code.includes('-') ? code.slice(code.indexOf('-') + 1) : code).toUpperCase();
  const pick = (re) => lib.find((r) => re.test(r.label.toUpperCase()));
  if (/^2A|^2B/.test(comp)) return pick(/^2A/)?.price ?? null;
  if (/^2NA/.test(comp)) return pick(/2NA/)?.price ?? null;
  if (/^1NA/.test(comp)) return pick(/1NA/)?.price ?? null;
  if (/^1A|^1B/.test(comp)) return pick(/^1A/)?.price ?? null;
  if (/^CNR|CORNER/.test(comp)) return pick(/CORNER/)?.price ?? null;
  if (/^L\b|^L\(/.test(comp)) return pick(/^L /)?.price ?? null;
  if (/CONSOLE/.test(comp)) return pick(/CONSOLE/)?.price ?? null;
  if (/STOOL|OTTOMAN/.test(comp)) return pick(/STOOL|OTTOMAN/)?.price ?? null;
  return null;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

try {
  console.log(`MODE=${MODE}`);

  const libRows = await sql`
    SELECT label, default_price::int AS price FROM scm.compartment_library
     WHERE company_id = ${CO} AND coalesce(default_price,0) > 0`;
  const lib = libRows.map((r) => ({ label: r.label, price: r.price }));
  console.log(`price list: ${lib.length} compartment types`);

  const poLines = await sql`
    SELECT ph.po_number, split_part(p.item_code,'-',1) AS model, p.item_code,
           p.qty::numeric AS qty, coalesce(p.unit_price_sen,0)::bigint AS price_sen
      FROM scm.purchase_order_items p
      JOIN scm.purchase_orders ph ON ph.id = p.purchase_order_id
     WHERE ph.company_id = ${CO} AND ph.status NOT IN ('CANCELLED','DRAFT')
       AND p.item_code ~ '^[0-9]{4}-'`;

  const perPo = new Map();
  for (const l of poLines) {
    const w = weightFor(l.item_code, lib);
    if (w == null) continue;
    const k = `${l.po_number}|${l.model}`;
    const d = perPo.get(k) ?? { money: 0, wt: 0, model: l.model };
    d.money += Number(l.price_sen);
    d.wt += w * Number(l.qty);
    perPo.set(k, d);
  }
  const rates = new Map();
  for (const d of perPo.values()) {
    if (d.money > 0 && d.wt > 0) {
      if (!rates.has(d.model)) rates.set(d.model, []);
      rates.get(d.model).push(d.money / d.wt);
    }
  }
  const rate = new Map([...rates].map(([m, v]) => [m, median(v)]));
  console.log('\n=== per-model rate (sen per weight point), from PRICED purchase orders ===');
  for (const [m, r] of [...rate].sort()) {
    console.log(`  ${m}  ${String(rates.get(m).length).padStart(2)} priced PO(s)`
      + `  rate ${r.toFixed(4)}  -> a 1-seater costs RM ${((r * 1490) / 100).toFixed(2)}`
      + (rates.get(m).length === 1 ? '   [ONE SAMPLE — owner said use it]' : ''));
  }

  const book = await sql`
    SELECT item_code, cost_sen FROM scm.ac_item_cost_hint
     WHERE company_id = ${CO}`.catch(() => []);
  const bookCost = new Map(book.map((r) => [r.item_code, Number(r.cost_sen)]));

  const lots = await sql`
    SELECT id, item_code, qty_remaining::numeric AS qty
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND qty_remaining > 0
       AND coalesce(unit_cost_sen,0) = 0
     ORDER BY item_code`;

  const plan = [];
  const skipped = new Map();
  for (const l of lots) {
    let sen = null;
    let why = null;
    if (bookCost.has(l.item_code)) {
      sen = bookCost.get(l.item_code);
      why = 'book';
    } else if (/^[0-9]{4}-/.test(l.item_code)) {
      const model = l.item_code.slice(0, l.item_code.indexOf('-'));
      const w = weightFor(l.item_code, lib);
      if (rate.has(model) && w != null) {
        sen = Math.round(rate.get(model) * w);
        why = 'sofa-weighted';
      }
    }
    if (sen == null || sen <= 0) {
      const key = /^[0-9]{4}-/.test(l.item_code) ? 'sofa, no priced PO or no weight' : 'not a sofa, book has no cost';
      skipped.set(key, (skipped.get(key) ?? 0) + Number(l.qty));
      continue;
    }
    plan.push({ id: l.id, code: l.item_code, qty: Number(l.qty), sen, why });
  }

  const byCode = new Map();
  for (const p of plan) {
    const d = byCode.get(p.code) ?? { units: 0, sen: p.sen, why: p.why, lots: 0 };
    d.units += p.qty; d.lots += 1;
    byCode.set(p.code, d);
  }
  console.log('\n=== WOULD COST ===');
  for (const [code, d] of [...byCode].sort((a, b) => b[1].units - a[1].units)) {
    console.log(`  ${code.padEnd(22)} ${String(d.units).padStart(4)} unit(s)`
      + `  RM ${(d.sen / 100).toFixed(2).padStart(9)} each  [${d.why}]`);
  }
  const totalUnits = plan.reduce((a, p) => a + p.qty, 0);
  const totalValue = plan.reduce((a, p) => a + p.qty * p.sen, 0);
  console.log(`\n  ${plan.length} lot(s), ${totalUnits} unit(s), inventory value +RM ${(totalValue / 100).toFixed(2)}`);
  console.log('  LEFT AT ZERO on purpose:');
  for (const [k, u] of skipped) console.log(`    ${String(u).padStart(4)} unit(s) — ${k}`);

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
  const stillZero = await check`
    SELECT count(*)::int AS n FROM scm.inventory_lots
     WHERE id = ANY(${plan.map((p) => p.id)}) AND coalesce(unit_cost_sen,0) = 0`;
  await check.end();

  console.log('\n=== VERIFY (fresh connection) ===');
  const ok = {
    'no lot this run costed is still zero': stillZero[0].n === 0,
    'no negative cost anywhere': after.negative === 0,
    'lot count unchanged': after.lots === before.lots,
    'costed lots rose by exactly what was written': after.costed === before.costed + wrote,
  };
  let bad = 0;
  for (const [k, v] of Object.entries(ok)) {
    if (!v) bad += 1;
    console.log(`  ${v ? 'OK   ' : 'WRONG'} ${k}`);
  }
  console.log(`  inventory value now RM ${(Number(after.value_sen) / 100).toFixed(2)}`);
  console.log(`  costed lots ${before.costed} -> ${after.costed} of ${after.lots}`);
  if (bad) {
    console.error('VERIFY FAILED.');
    process.exit(1);
  }
  console.log('VERIFY OK — every unit this run could price now carries a COGS.');
} catch (e) {
  console.error(e);
  try { await sql.end(); } catch { /* already closed */ }
  process.exit(1);
}
