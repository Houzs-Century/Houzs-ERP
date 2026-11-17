#!/usr/bin/env node
/* Take a sofa SET's price off the one piece it was charged to.

   THE DAMAGE (found 2026-11-17, owner's negative-margin screenshot). Some
   combo prices were stored as ONE slot listing several codes, e.g. LOTTI
   [2A(LHF) | 2A(RHF) | L(LHF) | L(RHF)] priced as the 2A + L set. Codes in a
   slot are alternatives for ONE piece, so the old costing matched such a combo
   to a single piece of an order and wrote the whole set's price on it, while
   the order's other pieces kept their own cost: 2990-SO-2610-057 (LOTTI 2A + L)
   showed a cost above its selling price and a negative margin. 17 of 235 live
   2990 multi-piece sofa orders carried it.

   THE FIX IN THE APP (same PR) stops new damage: a one-slot, several-code
   combo is refused on entry and never prices cost, the combo covering the most
   pieces wins, and cost reads the cost grid only. It cannot heal an order on
   its own: once a set price sits on a piece, nothing in the app knows that
   piece's cost any more. That is what this script restores.

   WHAT IT DOES, per company (COMPANY, default 2):
     1. lists every live combo row of the wrong shape and, on apply, retires it
        (deleted_at = now()). A person re-enters the real set prices in the
        right shape; the combo screen now refuses the wrong one.
     2. finds every live order line (not DRAFT / CANCELLED) whose cost equals a
        wrong-shaped combo's price at that line's height, and re-costs its
        order with lib/sofa-combo-set-cost.mjs: the piece gets back its build
        sibling's share or its price-list cost, then the fixed cost spread runs,
        so a combo that covers the whole set prices it. Header cost, margin and
        margin basis follow; an audit row names the change. What the rules
        cannot decide is REFUSED and printed.
   SKIP_DOCS=doc,doc leaves orders out of the apply (they are still printed).

   MODE=plan (default) prints every row and order and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". Each order is one
   transaction whose every UPDATE is guarded on the value the plan read, so an
   order edited since the plan is skipped, not overwritten. It then re-reads on
   a FRESH connection: no live wrong-shaped combo, every repaired order's header
   equals the sum of its lines, and no repaired line carries a set price.

   REVERSAL: the apply prints each retired combo id (UPDATE
   scm.sofa_combo_pricing SET deleted_at = NULL WHERE id IN (...)) and each
   line's cost before and after.

   RE-RUN: idempotent. Retired combos are no longer live and a repaired line
   no longer equals a set price, so a second run lists 0 combos and 0 orders
   (refused and skipped orders are listed again).

   Money in the output is redacted when it runs in GitHub Actions (this
   repository is public): the run shows which orders, lines and rules; the
   figures are read on a machine with database access. */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { isOnePieceSetCombo } from '../src/scm/shared/sofa-combo-pricing.ts';
import { todayMyt } from '../src/scm/lib/my-time.ts';
import {
  costCombos, isoDay, listCostOf, onePieceSetPrices, repairOrder, setPriceOn,
} from './lib/sofa-combo-set-cost.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY || 2);
const SKIP = new Set(String(process.env.SKIP_DOCS || '').split(',').map((s) => s.trim()).filter(Boolean));
const SOURCE = 'script:repair-sofa-combo-set-cost';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (!Number.isInteger(CO) || CO <= 0) { bad(`COMPANY must be one company id, got "${process.env.COMPANY}"`); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (num, den) => (den > 0 ? `${((num / den) * 100).toFixed(1)}%` : '-');
const slots = (m) => (m ?? []).map((s) => (Array.isArray(s) ? s.join(' | ') : s)).join('] + [');
const goodsOf = (o) => Number(o.mattress_sofa_sen || 0) + Number(o.bedframe_sen || 0) + Number(o.accessories_sen || 0) + Number(o.others_sen || 0);

async function readState(db) {
  const combos = await db`
    SELECT c.id::text, c.base_model, c.modules, c.tier, c.customer_id, c.supplier_id::text, s.name AS supplier,
           c.prices_by_height, c.selling_prices_by_height, c.label, c.effective_from, c.created_at, c.deleted_at
      FROM scm.sofa_combo_pricing c LEFT JOIN scm.suppliers s ON s.id = c.supplier_id
     WHERE c.company_id = ${CO}`;
  const setPrices = onePieceSetPrices(combos);
  const sofaLines = await db`
    SELECT i.id::text, i.doc_no, i.item_code, i.item_group, i.qty, i.line_cost_sen, i.variants, i.cancelled
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = ${CO}
     WHERE i.company_id = ${CO} AND NOT i.cancelled AND lower(i.item_group) = 'sofa'
       AND o.status NOT IN ('DRAFT', 'CANCELLED')`;
  const docs = [...new Set(sofaLines.filter((l) => setPriceOn(l, setPrices)).map((l) => l.doc_no))].sort();
  const orders = docs.length ? await db`
    SELECT doc_no, so_date, status, venue, local_total_sen, total_cost_sen, total_margin_sen, service_cost_sen,
           mattress_sofa_cost_sen, mattress_sofa_sen, bedframe_sen, accessories_sen, others_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${docs}::text[]) ORDER BY doc_no` : [];
  const lines = docs.length ? await db`
    SELECT id::text, doc_no, item_code, item_group, qty, unit_price_sen, total_sen, unit_cost_sen, line_cost_sen, variants, cancelled
      FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ANY(${docs}::text[]) ORDER BY doc_no, id` : [];
  const codes = [...new Set(lines.map((l) => l.item_code))];
  const products = codes.length ? await db`
    SELECT code, seat_height_prices FROM scm.mfg_products WHERE company_id = ${CO} AND code = ANY(${codes}::text[])` : [];
  const fabrics = await db`SELECT fabric_code, sofa_price_tier, price_tier FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  return { combos, setPrices, orders, lines, products, fabrics };
}

function planAll(state) {
  const productByCode = new Map(state.products.map((p) => [p.code, p]));
  const tierByFabric = new Map(state.fabrics.map((f) => [f.fabric_code, f.sofa_price_tier ?? f.price_tier ?? 'PRICE_2']));
  const tierOfFabric = (code) => tierByFabric.get(code) ?? 'PRICE_2';
  const ctx = {
    setPrices: state.setPrices,
    combos: costCombos(state.combos),
    tierOfFabric,
    listCost: (l) => listCostOf(productByCode.get(l.item_code), l, tierOfFabric(String(l.variants?.fabricCode ?? ''))),
    asOf: todayMyt(),
  };
  return state.orders.map((o) => ({ order: o, result: repairOrder(o, state.lines.filter((l) => l.doc_no === o.doc_no), ctx) }));
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} asOf=${todayMyt()}${SKIP.size ? ` skip=${[...SKIP].join(',')}` : ''}`);
  const state = await readState(sql);

  const retire = state.combos.filter((c) => c.deleted_at == null && isOnePieceSetCombo(c.modules ?? []));
  note(`\n=== WRONG-SHAPED COMBO ROWS (one slot listing several codes), live: ${retire.length} ===`);
  for (const c of retire) {
    const cost = Object.entries(c.prices_by_height ?? {}).filter(([, v]) => typeof v === 'number').map(([h, v]) => `${h}=${rm(v)}`).join(' ');
    const sell = Object.entries(c.selling_prices_by_height ?? {}).filter(([, v]) => typeof v === 'number').map(([h, v]) => `${h}=${rm(v)}`).join(' ');
    note(`  ${c.supplier_id ? `[${c.supplier}]` : '[master]'} ${c.base_model} [${slots(c.modules)}] ${c.tier ?? 'any tier'}  cost ${cost || '-'}  selling ${sell || '-'}  created ${isoDay(c.created_at)}  id ${c.id}`);
  }

  const plans = planAll(state);
  const repair = plans.filter((p) => p.result.status === 'repair' && !SKIP.has(p.order.doc_no));
  const skipped = plans.filter((p) => p.result.status === 'repair' && SKIP.has(p.order.doc_no));
  const refused = plans.filter((p) => p.result.status === 'refused');
  note(`\n=== ORDERS CARRYING A SET PRICE ON ONE PIECE: ${plans.length} (repair ${repair.length}, skipped ${skipped.length}, refused ${refused.length}) ===`);
  let goods = 0, before = 0, after = 0;
  for (const p of [...repair, ...skipped]) {
    const o = p.order; const r = p.result;
    const g = goodsOf(o);
    const costBefore = Number(o.total_cost_sen) - Number(o.service_cost_sen || 0);
    const costAfter = Number(r.header.total_cost_sen) - Number(o.service_cost_sen || 0);
    if (!SKIP.has(o.doc_no)) { goods += g; before += costBefore; after += costAfter; }
    note(`  ${o.doc_no}  ${isoDay(o.so_date)}  ${o.status}  ${o.venue ?? ''}${SKIP.has(o.doc_no) ? '  (SKIPPED: SKIP_DOCS)' : ''}`);
    note(`      goods ${rm(g)}   cost ${rm(costBefore)} -> ${rm(costAfter)}   margin ${pct(g - costBefore, g)} -> ${pct(g - costAfter, g)}`);
    for (const c of r.changes) note(`      ${c.item_code.padEnd(24)} ${rm(c.from)} -> ${rm(c.to)}  (${c.how})  line ${c.id}`);
  }
  for (const p of refused) bad(`  REFUSED ${p.order.doc_no}: ${p.result.why}`);
  note(`\n  ${repair.length} order(s): goods ${rm(goods)}; cost ${rm(before)} -> ${rm(after)} (${rm(after - before)}); margin ${pct(goods - before, goods)} -> ${pct(goods - after, goods)}`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  note(`\n=== RETIRING ${retire.length} COMBO ROW(S) ===`);
  const retired = [];
  for (const c of retire) {
    const back = await sql`UPDATE scm.sofa_combo_pricing SET deleted_at = now(), updated_at = now()
                            WHERE id = ${c.id} AND company_id = ${CO} AND deleted_at IS NULL RETURNING id::text`;
    if (back.length) retired.push(c.id);
  }
  note(`  retired ${retired.length} of ${retire.length}. REVERSAL: UPDATE scm.sofa_combo_pricing SET deleted_at = NULL WHERE id IN ('${retired.join("','")}')`);

  note(`\n=== RE-COSTING ${repair.length} ORDER(S) ===`);
  const applied = [];
  for (const p of repair) {
    const o = p.order; const r = p.result;
    try {
      await sql.begin(async (tx) => {
        for (const c of r.changes) {
          const hit = await tx`UPDATE scm.mfg_sales_order_items
                                  SET line_cost_sen = ${c.to}, unit_cost_sen = ${Math.round(c.to / c.qty)}, line_margin_sen = ${c.total_sen - c.to}
                                WHERE id = ${c.id} AND doc_no = ${o.doc_no} AND company_id = ${CO} AND NOT cancelled AND line_cost_sen = ${c.from}
                                RETURNING id`;
          if (!hit.length) throw new Error(`line ${c.item_code} changed since the plan`);
        }
        const head = await tx`UPDATE scm.mfg_sales_orders
                                 SET total_cost_sen = ${r.header.total_cost_sen}, mattress_sofa_cost_sen = ${r.header.mattress_sofa_cost_sen},
                                     total_margin_sen = ${r.header.total_margin_sen}, margin_pct_basis = ${r.header.margin_pct_basis},
                                     version = version + 1, updated_at = now()
                               WHERE doc_no = ${o.doc_no} AND company_id = ${CO} AND total_cost_sen = ${o.total_cost_sen}
                               RETURNING doc_no`;
        if (!head.length) throw new Error('header changed since the plan');
        await tx`INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
                 VALUES (${o.doc_no}, ${CO}, 'UPDATE_LINE', 'System (combo set-cost repair)',
                         ${tx.json(r.changes.map((c) => ({ field: `line_${c.item_code}_line_cost_sen`, from: c.from, to: c.to })))},
                         ${o.status}, ${SOURCE},
                         ${'Cost repaired: a sofa set price had been charged to one piece by a combo stored as one slot listing several codes'})`;
      });
      applied.push(p);
      note(`  OK   ${o.doc_no}`);
    } catch (e) {
      bad(`  SKIP ${o.doc_no}: ${e.message}`);
    }
  }
  note(`  re-costed ${applied.length} of ${repair.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const live = await check`SELECT id::text, modules FROM scm.sofa_combo_pricing WHERE company_id = ${CO} AND deleted_at IS NULL`;
    const leftShapes = live.filter((c) => isOnePieceSetCombo(c.modules ?? [])).length;
    (leftShapes ? bad : note)(`  live wrong-shaped combo rows: ${leftShapes}`);
    const docs = applied.map((p) => p.order.doc_no);
    if (docs.length) {
      const heads = await check`SELECT doc_no, total_cost_sen, mattress_sofa_cost_sen FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${docs}::text[])`;
      const ls = await check`SELECT id::text, doc_no, item_code, item_group, qty, total_sen, line_cost_sen, line_margin_sen, variants, cancelled
                               FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ANY(${docs}::text[])`;
      const setPrices = onePieceSetPrices(await check`SELECT id::text, base_model, modules, prices_by_height, selling_prices_by_height FROM scm.sofa_combo_pricing WHERE company_id = ${CO}`);
      let wrong = 0;
      for (const h of heads) {
        const mine = ls.filter((l) => l.doc_no === h.doc_no && !l.cancelled);
        const sum = mine.reduce((s, l) => s + Number(l.line_cost_sen), 0);
        const sofaSum = mine.filter((l) => /mattress|sofa/.test(String(l.item_group ?? '').toLowerCase())).reduce((s, l) => s + Number(l.line_cost_sen), 0);
        const stillSet = mine.filter((l) => setPriceOn(l, setPrices)).length;
        const marginOff = mine.filter((l) => Number(l.line_margin_sen) !== Number(l.total_sen) - Number(l.line_cost_sen)).length;
        if (sum !== Number(h.total_cost_sen) || sofaSum !== Number(h.mattress_sofa_cost_sen) || stillSet || marginOff) {
          wrong++;
          bad(`  ${h.doc_no}: header total_cost_sen=${h.total_cost_sen} vs lines_sen=${sum}; mattress_sofa_cost_sen=${h.mattress_sofa_cost_sen} vs sofa_lines_sen=${sofaSum}; set-priced lines ${stillSet}; line margins off ${marginOff}`);
        }
      }
      note(`  repaired orders whose header equals their lines and carry no set price: ${heads.length - wrong} of ${heads.length}`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
