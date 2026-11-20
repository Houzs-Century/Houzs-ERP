#!/usr/bin/env node
/* Put named lines of ONE sales order on a cost the owner decided.

   WHY. The repair scripts cost a line from the price list; now and then the
   owner rules on one order the rules cannot settle. First use, owner
   2026-11-20 (「改回 1,512」): 2990-SO-2608-042, a POS sale of 25 Aug 2026, carried
   RM 1,512.00 for its XAMMAR 1A + 2A at the sale, as the same pieces sold on the
   POS the same week still do; a delivery-date-only amendment on 17 Nov spread a
   set price created on 19 Oct over them. The price list of that day would say
   another figure, so the owner set the sale-day cost.

   WHAT IT DOES. COMPANY, DOC, LINES (<line uuid>:<cost in sen>,...) and REASON
   are required. lib/so-line-cost-set.mjs plans it: each named line takes its
   cost (unit cost = cost / qty, line margin = line total - cost); the header's
   cost, its category column, margin and margin basis move by the same amount.
   An order that is DRAFT or CANCELLED, whose header is not the sum of its lines,
   that does not hold a named line, or that has nothing to change is REFUSED.

   MODE=plan (default) prints the plan and writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN". It writes in one transaction, every
   UPDATE guarded on the value the plan read (an order edited since the plan is
   skipped, not overwritten), with an audit row naming each line's cost before
   and after and the REASON. It then re-reads on a FRESH connection: each named
   line carries its cost and margin, the header equals the sum of its lines,
   and a new plan finds nothing to change.

   REVERSAL: the audit row (scm.mfg_so_audit_log, source script:set-so-line-cost)
   keeps each line's cost before; re-run this script with those costs.

   RE-RUN: idempotent. Once the lines carry their costs a second run refuses the
   order as having nothing to change and writes nothing.

   Money in the output is redacted when it runs in GitHub Actions (this
   repository is public): the figures are read on a machine with database access. */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { parseLineCosts, planLineCosts } from './lib/so-line-cost-set.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const SOURCE = 'script:set-so-line-cost';
const CO = Number(process.env.COMPANY);
const DOC = String(process.env.DOC || '').trim();
const REASON = String(process.env.REASON || '').trim();

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
if (!Number.isInteger(CO) || CO <= 0) { bad(`COMPANY must be one company id, got "${process.env.COMPANY ?? ''}"`); process.exit(2); }
if (!DOC) { bad('DOC must name the order'); process.exit(2); }
if (REASON.length < 10 || REASON.length > 300) { bad('REASON must say, in 10 to 300 characters, who decided the cost and why'); process.exit(2); }
let WANTED;
try { WANTED = parseLineCosts(process.env.LINES); } catch (e) { bad(e instanceof Error ? e.message : String(e)); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function readState(db) {
  const [order] = await db`
    SELECT doc_no, status, total_cost_sen, total_revenue_sen, total_margin_sen,
           mattress_sofa_cost_sen, bedframe_cost_sen, accessories_cost_sen, service_cost_sen, others_cost_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${DOC}`;
  const lines = await db`
    SELECT id::text, item_code, item_group, qty, total_sen, line_cost_sen, line_margin_sen, cancelled
      FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND doc_no = ${DOC} ORDER BY id`;
  return { order, lines };
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (writes nothing)'} company=${CO} order=${DOC} lines named=${WANTED.size}`);
  const state = await readState(sql);
  if (!state.order) { bad(`NOT FOUND in company ${CO}: ${DOC}`); await sql.end({ timeout: 5 }); process.exit(1); }
  const plan = planLineCosts(state.order, state.lines, WANTED);
  if (plan.status === 'refused') {
    bad(`REFUSED ${DOC}: ${plan.why}`);
    await sql.end({ timeout: 5 });
    process.exit(plan.why.startsWith('nothing to change') ? 0 : 1);
  }
  note(`\n=== ${DOC}: cost ${rm(state.order.total_cost_sen)} -> ${rm(plan.header.total_cost_sen)} ===`);
  for (const c of plan.changes) note(`  ${c.item_code.padEnd(24)} ${rm(c.from)} -> ${rm(c.to)}  line ${c.id}`);
  if (!APPLY) {
    note(`\nPLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }

  await sql.begin(async (tx) => {
    for (const c of plan.changes) {
      const hit = await tx`UPDATE scm.mfg_sales_order_items
                              SET line_cost_sen = ${c.to}, unit_cost_sen = ${Math.round(c.to / c.qty)}, line_margin_sen = ${c.total_sen - c.to}
                            WHERE id = ${c.id} AND doc_no = ${DOC} AND company_id = ${CO} AND NOT cancelled AND line_cost_sen = ${c.from}
                            RETURNING id`;
      if (!hit.length) throw new Error(`line ${c.item_code} changed since the plan`);
    }
    const head = await tx`UPDATE scm.mfg_sales_orders SET ${tx(plan.header)}, version = version + 1, updated_at = now()
                           WHERE doc_no = ${DOC} AND company_id = ${CO} AND total_cost_sen = ${state.order.total_cost_sen}
                           RETURNING doc_no`;
    if (!head.length) throw new Error('header changed since the plan');
    await tx`INSERT INTO scm.mfg_so_audit_log (so_doc_no, company_id, action, actor_name_snapshot, field_changes, status_snapshot, source, note)
             VALUES (${DOC}, ${CO}, 'UPDATE_LINE', 'System (owner-decided cost)',
                     ${tx.json(plan.changes.map((c) => ({ field: `line_${c.item_code}_line_cost_sen`, from: c.from, to: c.to })))},
                     ${state.order.status}, ${SOURCE}, ${REASON})`;
  });
  note(`  OK   ${DOC}`);

  await sql.end({ timeout: 5 });
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const fresh = await readState(check);
    const live = fresh.lines.filter((l) => !l.cancelled);
    const sum = live.reduce((s, l) => s + Number(l.line_cost_sen), 0);
    const off = plan.changes.filter((c) => {
      const l = live.find((x) => x.id === c.id);
      return !l || Number(l.line_cost_sen) !== c.to || Number(l.line_margin_sen) !== c.total_sen - c.to;
    });
    const again = planLineCosts(fresh.order, fresh.lines, WANTED);
    const settled = again.status === 'refused' && again.why.startsWith('nothing to change');
    const headerMatches = sum === Number(fresh.order.total_cost_sen);
    if (!headerMatches || off.length || !settled) {
      bad(`  ${DOC}: header equals its lines ${headerMatches}; lines not as planned ${off.length}; a new plan finds nothing to change ${settled}`);
      process.exitCode = 1;
    } else {
      note(`  ${DOC}: named lines carry their costs, the header equals its lines, and a new plan leaves it alone`);
    }
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e instanceof Error ? e.message : String(e));
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
