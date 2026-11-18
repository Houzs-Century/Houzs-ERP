#!/usr/bin/env node
/* Re-cost the sofa sets the nightly cost fill costed off their set price.

   THE DAMAGE (found 2026-11-18). The nightly cost fill
   (restamp-so-cost-from-product.mjs) read a combo's start date with
   String(Date), "Mon Oct 19", so no combo was ever in effect for it. A set with
   every piece at RM 0 got the sum of its pieces' own costs instead of its set
   price (6 Houzs orders, filled 2026-11-04). A set whose save had put the whole
   set price on one piece, its other piece having no cost yet, got that piece
   costed again on top (HC-SO-2609-359). The fill now costs such a set at its set
   price (lib/so-line-unit-cost.mjs wholeSetCosts); this script re-costs the
   orders it already filled. The owner chose the orders (2026-11-18): fills from
   before the fill priced sets stay as they are, so the orders are named, not
   searched for.

   WHAT IT DOES. COMPANY and DOCS are required. For each named order, every sofa
   piece a combo covers is re-costed to the set price, shared by each piece's own
   price-list cost, as a save prices the set (recostSetOrder). Header cost, margin
   and margin basis follow; an audit row names each line's cost before and after.
   An order that is DRAFT or CANCELLED, whose header is not the sum of its lines,
   or that has nothing to change is REFUSED and printed.

   MODE=plan (default) prints every order and line and writes nothing.
   MODE=apply needs CONFIRM="I HAVE REVIEWED THE DRY-RUN". Each order is one
   transaction whose every UPDATE is guarded on the value the plan read, so an
   order edited since the plan is skipped, not overwritten. It then re-reads on a
   FRESH connection: every re-costed line carries its planned cost and margin,
   each header equals the sum of its lines, and a new plan finds nothing to change.

   REVERSAL: the apply prints each line's cost before and after, and the audit row
   (scm.mfg_so_audit_log, source script:repair-fill-sofa-set-cost) keeps them.
   Restore a line with UPDATE scm.mfg_sales_order_items SET line_cost_sen = <from>,
   unit_cost_sen = <from / qty>, line_margin_sen = total_sen - <from> WHERE id = <id>,
   then move the header's total_cost_sen, mattress_sofa_cost_sen and
   total_margin_sen back by the same difference.

   RE-RUN: idempotent. A re-costed order already carries its set price, so a
   second run refuses it as having nothing to change and writes nothing.

   Money in the output is redacted when it runs in GitHub Actions (this
   repository is public): the run shows which orders and lines; the figures are
   read on a machine with database access. */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { recostSetOrder, unitCostSen, usualHeights } from './lib/so-line-unit-cost.mjs';
import { costCombos, isoDay } from './lib/sofa-combo-set-cost.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const CO = Number(process.env.COMPANY);
const DOCS = [...new Set(String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean))];
const SOURCE = 'script:repair-fill-sofa-set-cost';

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (!Number.isInteger(CO) || CO <= 0) { bad(`COMPANY must be one company id, got "${process.env.COMPANY ?? ''}"`); process.exit(2); }
if (DOCS.length === 0) { bad('DOCS must name the orders to re-cost, e.g. DOCS=HC-SO-010925,HC-SO-011219'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function readState(db) {
  const orders = await db`
    SELECT doc_no, so_date, status, total_revenue_sen, total_cost_sen, total_margin_sen, mattress_sofa_cost_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${DOCS}::text[]) ORDER BY doc_no`;
  const lines = await db`
    SELECT id::text, doc_no, item_code, item_group, qty, total_sen, line_cost_sen, line_margin_sen, variants, cancelled
      FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ANY(${DOCS}::text[]) ORDER BY doc_no, id`;
  const codes = [...new Set(lines.map((l) => l.item_code))];
  const products = codes.length ? await db`
    SELECT code, category, base_price_sen, cost_price_sen, seat_height_prices
      FROM scm.mfg_products WHERE company_id = ${CO} AND code = ANY(${codes}::text[])` : [];
  // The heights each SKU sells at most, as the fill reads them (unitCostSen).
  const heightCounts = await db`
    SELECT item_code, coalesce(variants->>'seatHeight', variants->>'seat_height', variants->>'depth') AS height, count(*)::int AS n
      FROM scm.mfg_sales_order_items
     WHERE company_id = ${CO} AND coalesce(variants->>'seatHeight', variants->>'seat_height', variants->>'depth') IS NOT NULL
     GROUP BY 1, 2`;
  const comboRows = await db`
    SELECT id::text, base_model, modules, tier, customer_id, supplier_id, deleted_at, prices_by_height, label, effective_from, created_at
      FROM scm.sofa_combo_pricing
     WHERE company_id = ${CO} AND deleted_at IS NULL AND customer_id IS NULL AND supplier_id IS NULL`;
  const fabrics = await db`
    SELECT fabric_code, coalesce(sofa_price_tier, price_tier, 'PRICE_2') AS tier FROM scm.fabric_trackings WHERE company_id = ${CO}`;
  return { orders, lines, products, usual: usualHeights(heightCounts), combos: costCombos(comboRows), fabrics };
}

function planAll(state) {
  const productByCode = new Map(state.products.map((p) => [p.code, p]));
  const tierByFabric = new Map(state.fabrics.map((f) => [f.fabric_code, f.tier]));
  const ctx = {
    combos: state.combos,
    tierOfFabric: (code) => tierByFabric.get(code) ?? 'PRICE_2',
    ownCost: (l) => unitCostSen(productByCode.get(l.item_code), l.variants, state.usual),
  };
  return state.orders.map((o) => ({ order: o, result: recostSetOrder(o, state.lines.filter((l) => l.doc_no === o.doc_no), ctx) }));
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} orders named=${DOCS.length}`);
  const state = await readState(sql);
  const missing = DOCS.filter((d) => !state.orders.some((o) => o.doc_no === d));
  for (const d of missing) bad(`  NOT FOUND in company ${CO}: ${d}`);

  const plans = planAll(state);
  const repair = plans.filter((p) => p.result.status === 'repair');
  const refused = plans.filter((p) => p.result.status === 'refused');
  note(`\n=== ORDERS TO RE-COST TO THEIR SET PRICE: ${repair.length} (refused ${refused.length}, not found ${missing.length}) ===`);
  let before = 0, after = 0;
  for (const p of repair) {
    const o = p.order; const r = p.result;
    before += Number(o.total_cost_sen); after += r.header.total_cost_sen;
    note(`  ${o.doc_no}  ${isoDay(o.so_date)}  ${o.status}   cost ${rm(o.total_cost_sen)} -> ${rm(r.header.total_cost_sen)}`);
    for (const c of r.changes) note(`      ${c.item_code.padEnd(24)} ${rm(c.from)} -> ${rm(c.to)}  line ${c.id}`);
  }
  for (const p of refused) bad(`  REFUSED ${p.order.doc_no}: ${p.result.why}`);
  note(`\n  ${repair.length} order(s): cost ${rm(before)} -> ${rm(after)} (${rm(after - before)})`);

  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

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
                 VALUES (${o.doc_no}, ${CO}, 'UPDATE_LINE', 'System (sofa set-price repair)',
                         ${tx.json(r.changes.map((c) => ({ field: `line_${c.item_code}_line_cost_sen`, from: c.from, to: c.to })))},
                         ${o.status}, ${SOURCE},
                         ${'Cost repaired: the sofa set costs its set price, spread over its pieces by their own cost, as the nightly cost fill now does'})`;
      });
      applied.push(p);
      note(`  OK   ${o.doc_no}`);
      for (const c of r.changes) note(`       ${c.item_code.padEnd(24)} ${rm(c.from)} -> ${rm(c.to)}  line ${c.id}`);
    } catch (e) {
      bad(`  SKIP ${o.doc_no}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  note(`  re-costed ${applied.length} of ${repair.length}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  let wrong = 0;
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    if (applied.length) {
      const fresh = await readState(check);
      const replan = new Map(planAll(fresh).map((p) => [p.order.doc_no, p.result]));
      for (const p of applied) {
        const o = p.order;
        const head = fresh.orders.find((h) => h.doc_no === o.doc_no);
        const mine = fresh.lines.filter((l) => l.doc_no === o.doc_no && !l.cancelled);
        const sum = mine.reduce((s, l) => s + Number(l.line_cost_sen), 0);
        const off = p.result.changes.filter((c) => {
          const l = mine.find((x) => x.id === c.id);
          return !l || Number(l.line_cost_sen) !== c.to || Number(l.line_margin_sen) !== c.total_sen - c.to;
        });
        const again = replan.get(o.doc_no);
        const settled = again?.status === 'refused' && /nothing to change/.test(again.why);
        if (!head || sum !== Number(head.total_cost_sen) || off.length || !settled) {
          wrong++;
          bad(`  ${o.doc_no}: header equals its lines ${head ? sum === Number(head.total_cost_sen) : false}; lines not as planned ${off.length}; a new plan finds nothing to change ${settled}`);
        }
      }
    }
    (wrong ? bad : note)(`  re-costed orders whose lines carry the planned cost, whose header equals their lines, and that a new plan leaves alone: ${applied.length - wrong} of ${applied.length}`);
  } finally {
    await check.end({ timeout: 5 });
  }
  if (wrong) process.exit(1);
}

main().catch(async (e) => {
  bad(e instanceof Error ? e.message : String(e));
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
