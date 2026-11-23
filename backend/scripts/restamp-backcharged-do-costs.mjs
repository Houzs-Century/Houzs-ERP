#!/usr/bin/env node
/* Re-stamp the stored cost and margin on the delivery lines (and the invoice lines that bill them) whose stock-out
   was back-charged on 23 Nov 2026 by repair-short-out-lots.mjs (run 45148086919: 25 units on 21 DO lines).

   WHY. That repair charged the DO OUT movements from the open lots (their COGS on the movement is now right), but
   delivery_order_items keeps a DERIVED copy (unit_cost_sen / line_cost_sen / line_margin_sen) and
   sales_invoice_items copies the DO's. Both still show the old cost (mostly 0).

   HOW. No costing logic here: per DO it calls the app's own restampDoActualCost (routes/delivery-orders-mfg.ts) and
   restampSiFromDo (lib/recost.ts), the same pair every ship / receipt reconcile runs, through lib/pgrest-shim.mjs on
   one transaction (writeback suppressed: AutoCount gets no edit from a cost re-stamp). Customer amounts must not
   move: every DO line total, SI line total and SI header total is compared before and after, and any change is a
   refusal of the whole run.

   MODE=plan (default) runs the re-stamp inside the transaction, prints every line before -> after (cost, margin)
   and ROLLS BACK. MODE=apply needs CONFIRM="RESTAMP BACK-CHARGED DELIVERY COSTS" and re-reads on a fresh
   connection. Env: DATABASE_URL, MODE, CONFIRM, COMPANY (default 1), DOS (required: comma-separated DO numbers).
   Run under tsx (the runner does).

   RE-RUN: inert. The re-stamp derives the stored cost from the movements; a second run stamps the same values. */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'RESTAMP BACK-CHARGED DELIVERY COSTS';
const DOS = (process.env.DOS || '').split(',').map((s) => s.trim()).filter(Boolean);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);
const rm = (sen) => (sen == null ? '-' : (Number(sen) / 100).toFixed(2));

if (DOS.length === 0) { bad('DOS is required: the DO numbers to re-stamp'); process.exit(2); }
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

/** Every stored cost / margin / amount the re-stamp could touch for these DOs, keyed by row. */
async function snapshot(client, doIds) {
  const lines = await client.unsafe(`
    SELECT 'DO' AS doc, d.do_number AS no, i.id::text AS id, i.item_code, i.qty::numeric AS qty,
           i.unit_cost_sen, i.line_cost_sen, i.line_margin_sen, i.line_total_sen AS amount
      FROM scm.delivery_order_items i JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE i.delivery_order_id = ANY ($1::uuid[])
    UNION ALL
    SELECT 'SI', s.invoice_number, si.id::text, si.item_code, si.qty::numeric,
           si.unit_cost_sen, si.line_cost_sen, si.line_margin_sen, si.line_total_sen
      FROM scm.sales_invoice_items si JOIN scm.sales_invoices s ON s.id = si.sales_invoice_id
     WHERE si.do_item_id IN (SELECT id FROM scm.delivery_order_items WHERE delivery_order_id = ANY ($1::uuid[]))
    ORDER BY 1, 2, 4, 3`, [doIds]);
  const heads = await client.unsafe(`
    SELECT s.id::text AS id, s.invoice_number AS no, s.subtotal_sen, s.total_sen FROM scm.sales_invoices s
     WHERE s.id IN (SELECT si.sales_invoice_id FROM scm.sales_invoice_items si
                     WHERE si.do_item_id IN (SELECT id FROM scm.delivery_order_items WHERE delivery_order_id = ANY ($1::uuid[])))`, [doIds]);
  return { lines, heads };
}

function compare(before, after) {
  const a = new Map(after.lines.map((r) => [`${r.doc}|${r.id}`, r]));
  const rows = [], amountMoved = [];
  for (const b of before.lines) {
    const x = a.get(`${b.doc}|${b.id}`);
    if (!x) { amountMoved.push(`${b.doc} ${b.no} ${b.item_code}: row gone`); continue; }
    if (String(x.amount) !== String(b.amount)) amountMoved.push(`${b.doc} ${b.no} ${b.item_code}: amount_sen=${b.amount} -> amount_sen=${x.amount}`);
    rows.push({ b, x, changed: String(b.unit_cost_sen) !== String(x.unit_cost_sen) || String(b.line_margin_sen) !== String(x.line_margin_sen) });
  }
  const h = new Map(after.heads.map((r) => [r.id, r]));
  for (const b of before.heads) {
    const x = h.get(b.id);
    if (!x || String(x.subtotal_sen) !== String(b.subtotal_sen) || String(x.total_sen) !== String(b.total_sen)) {
      amountMoved.push(`SI ${b.no}: total_sen=${b.total_sen} -> total_sen=${x?.total_sen}`);
    }
  }
  return { rows, amountMoved };
}

function print(rows) {
  for (const { b, x, changed } of rows) {
    note(`  ${changed ? 'CHANGE' : 'same  '} ${b.doc} ${b.no} | ${b.item_code} x${Number(b.qty)} | unit cost ${rm(b.unit_cost_sen)} -> ${rm(x.unit_cost_sen)} | line cost ${rm(b.line_cost_sen)} -> ${rm(x.line_cost_sen)} | margin ${rm(b.line_margin_sen)} -> ${rm(x.line_margin_sen)} | amount ${rm(b.amount)}`);
  }
}

async function main() {
  note(`mode=${APPLY ? 'APPLY' : 'PLAN (rolled back)'} company=${CO} DOs requested: ${DOS.length}`);
  const dos = await sql`
    SELECT id::text AS id, do_number, status::text AS status FROM scm.delivery_orders
     WHERE company_id = ${CO} AND do_number = ANY (${DOS}) ORDER BY do_number`;
  const missing = DOS.filter((n) => !dos.some((d) => d.do_number === n));
  if (missing.length) { bad(`refusing: not found in company ${CO}: ${missing.join(', ')}`); process.exitCode = 2; await sql.end({ timeout: 5 }); return; }
  note(`  ${dos.length} DO(s): ${dos.map((d) => `${d.do_number} (${d.status})`).join(', ')}`);
  const doIds = dos.map((d) => d.id);
  const before = await snapshot(sql, doIds);

  /* Loaded here, not at the top, the way backfill-hard-bound-cost.mjs does: the route module is large. */
  const { pgrestShim } = await import('./lib/pgrest-shim.mjs');
  const { restampDoActualCost } = await import('../src/scm/routes/delivery-orders-mfg.ts');
  const { restampSiFromDo } = await import('../src/scm/lib/recost.ts');
  const ROLLBACK = new Error('plan rollback');
  try {
    await sql.begin(async (tx) => {
      const sb = pgrestShim(tx, 'scm');
      for (const d of dos) {
        await restampDoActualCost(sb, d.id);
        await restampSiFromDo(sb, d.id);
        if (sb.__gaps.length) throw new Error(`shim gap on ${d.do_number}: ${sb.__gaps.join('; ')}`);
      }
      const after = await snapshot(tx, doIds);
      const { rows, amountMoved } = compare(before, after);
      note(`\n=== LINES, BEFORE -> AFTER (${APPLY ? 'committing' : 'rolled back after'}) ===`);
      print(rows);
      note(`  lines changed: ${rows.filter((r) => r.changed).length} of ${rows.length} (DO ${rows.filter((r) => r.changed && r.b.doc === 'DO').length}, SI ${rows.filter((r) => r.changed && r.b.doc === 'SI').length})`);
      if (amountMoved.length) throw new Error(`refusing: a customer amount would change — ${amountMoved.join('; ')}`);
      note(`  customer amounts: none changed (${before.lines.length} lines, ${before.heads.length} invoice totals)`);
      if (!APPLY) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    note(`\nPLAN ONLY: rolled back, nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}".`);
    await sql.end({ timeout: 5 });
    return;
  }
  await sql.end({ timeout: 5 });

  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note(`\n=== VERIFIED ON A FRESH CONNECTION ===`);
    const after = await snapshot(check, doIds);
    const { rows, amountMoved } = compare(before, after);
    for (const m of amountMoved) bad(`  ${m}`);
    note(`  lines whose stored cost now differs from before: ${rows.filter((r) => r.changed).length} of ${rows.length}; customer amounts changed: ${amountMoved.length}`);
    /* Shape: each DO line's stored line cost equals unit cost x qty, and its margin equals amount - line cost. */
    const off = after.lines.filter((r) => r.doc === 'DO' && r.unit_cost_sen != null
      && (Number(r.line_cost_sen) !== Number(r.unit_cost_sen) * Number(r.qty) || Number(r.line_margin_sen) !== Number(r.amount) - Number(r.line_cost_sen)));
    for (const r of off) bad(`  ${r.no} ${r.item_code}: line_cost_sen=${r.line_cost_sen} line_margin_sen=${r.line_margin_sen} do not add up`);
    note(`  DO lines whose cost and margin do not add up: ${off.length}`);
    if (amountMoved.length) process.exitCode = 1;
  } finally {
    await check.end({ timeout: 5 });
  }
}

main().catch(async (e) => {
  bad(e.message);
  try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(1);
});
