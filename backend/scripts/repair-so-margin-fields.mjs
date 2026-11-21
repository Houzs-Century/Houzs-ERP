#!/usr/bin/env node
/* Put sales orders' margin fields where a save would put them.

   WHY. Owner 2026-11-21 chose A (fix the program and the old orders) for margin
   fields that do not follow cost:
     1. the AutoCount go-live import (import-ac-outstanding-so.mjs) wrote each
        order's total but no revenue, so imported Houzs orders read revenue 0,
        margin 0 - cost and margin basis 0;
     2. the nightly cost fill and the import stamp wrote a line's cost without
        its margin, so the line kept its full price (or 0) as its margin;
     3. the fill wrote header cost and margin without the margin basis.
   The writers are fixed in the same change; this repairs what they left.

   THE RULE (lib/so-margin.mjs planOrderMargins), as recomputeTotals writes it:
     line    line_margin_sen = total_sen - line_cost_sen
     header  a revenue of 0 under a positive order total takes that total, when
             the order's live lines add up to it; margin = revenue - cost;
             margin basis = margin / revenue in basis points (0 with no revenue).
   No cost, selling price, order total or payment moves. An order whose header
   cost is not the sum of its lines, or whose revenue disagrees with its total
   any other way, is REFUSED and named, never guessed. DRAFT and CANCELLED
   orders are left as they are (a draft is recomputed when it is confirmed).

   THE VENTURE PORTAL. Its payload carries revenue, margin, margin basis and
   every line margin, and its capture triggers fire on total_margin_sen and
   line_margin_sen, so every order corrected here is queued to the portal again
   (a header write always names total_margin_sen, so an order whose basis alone
   was off is re-sent too); the payload is rebuilt from the order at send time.
   PORTAL_LANE (required on apply):
     background  in each chunk's own transaction, the queue rows THAT
                 transaction created move to the reconcile lane (op
                 'RECONCILE'), which the sender serves after every live save,
                 so a salesperson's new order never waits behind the re-sends.
                 A row a live save had already queued is left as it is.
     normal      the rows stay as the triggers wrote them, ahead of later saves.
   The portal receives the same payloads either way.

   MODE=plan (default) prints counts and doc numbers, never money (this
   repository is public), and writes nothing. MODE=apply needs
   CONFIRM="I HAVE REVIEWED THE DRY-RUN". It writes CHUNK orders (default 200)
   per transaction, every UPDATE guarded on the values the plan read (an order
   edited since is skipped; its next save puts its margins right), with one
   audit row per order naming each changed field's value before and after. It
   then re-reads on a FRESH connection and checks each written order: its live
   lines' margin = total - cost, its revenue = its order total, its margin =
   revenue - cost and its basis = margin / revenue.

   Env: DATABASE_URL (required); COMPANY (optional, one company id; default
   every company); PORTAL_LANE (background | normal, required on apply);
   CHUNK (orders per transaction, default 200); LIST_LIMIT (doc numbers shown).

   REVERSAL: each order's audit row (scm.mfg_so_audit_log, source
   script:repair-so-margin-fields) keeps every changed field's value before; a
   line's entry carries its lineId. Restore those values by doc_no / line id.
   A re-send to the portal delivers the corrected state and cannot be recalled.

   RE-RUN: idempotent. An order it corrected already reads as a save would
   write it, so a second run plans nothing for it and writes nothing. */
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { planOrderMargins } from './lib/so-margin.mjs';
import { planCompanyMargins, readOrderMargins, writeMarginChunk } from './lib/so-margin-repair.mjs';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const APPLY = (process.env.MODE || 'plan').toLowerCase() === 'apply';
const CONFIRM_PHRASE = 'I HAVE REVIEWED THE DRY-RUN';
const ONLY_COMPANY = process.env.COMPANY ? Number(process.env.COMPANY) : null;
const LANE = String(process.env.PORTAL_LANE || '').trim().toLowerCase();
const CHUNK = Number(process.env.CHUNK) > 0 ? Number(process.env.CHUNK) : 200;
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 20;
const LEFT_ALONE = new Set(['DRAFT', 'CANCELLED']);

const note = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const bad = (m) => console.log(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR ${m}`);

if (ONLY_COMPANY != null && !(Number.isInteger(ONLY_COMPANY) && ONLY_COMPANY > 0)) {
  bad(`COMPANY must be one company id, got "${process.env.COMPANY}"`);
  process.exit(2);
}
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  bad(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}"`);
  process.exit(2);
}
if (APPLY && !['background', 'normal'].includes(LANE)) {
  bad('MODE=apply requires PORTAL_LANE=background or PORTAL_LANE=normal (where the portal re-sends wait)');
  process.exit(2);
}

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

const BANDS = ['before Aug 2026', 'Aug-Sep 2026', 'from Oct 2026'];
const band = (day) => (day < '2026-08-01' ? BANDS[0] : day < '2026-10-01' ? BANDS[1] : BANDS[2]);

function printPlan(co, read, p) {
  const lineCount = [...read.linesByDoc.values()].reduce((s, ls) => s + ls.length, 0);
  const filled = p.todo.filter((o) => o.plan.revenueFilled).length;
  const headerOnly = p.todo.filter((o) => o.plan.header && !o.plan.revenueFilled).length;
  const linesOnly = p.todo.filter((o) => !o.plan.header).length;
  const lines = p.todo.reduce((s, o) => s + o.plan.lines.length, 0);
  const byBand = new Map();
  for (const o of p.todo) byBand.set(band(o.h.so_date ?? ''), (byBand.get(band(o.h.so_date ?? '')) ?? 0) + 1);
  note(`===== Company ${co} =====`);
  note(`orders read: ${read.headers.length}; to correct: ${p.todo.length} (revenue filled from the order total: ${filled}; margin or margin basis only: ${headerOnly}; line margins only: ${linesOnly})`);
  note(`lines read: ${lineCount}; line margins to correct: ${lines}`);
  note(`Venture Portal: every order corrected is queued again: ${p.todo.length} (${BANDS.map((b) => `${b}: ${byBand.get(b) ?? 0}`).join('; ')})`);
  note(`left as they are (DRAFT or CANCELLED) though off: ${p.leftAlone}`);
  note(`refused: ${p.refused.length}`);
  p.refused.slice(0, LIST_LIMIT).forEach((r) => note(`  REFUSED ${r.doc}: ${r.why}`));
  if (p.refused.length > LIST_LIMIT) note(`  ... ${p.refused.length - LIST_LIMIT} more refused.`);
  if (p.todo.length) note(`first ${Math.min(LIST_LIMIT, p.todo.length)} to correct: ${p.todo.slice(0, LIST_LIMIT).map((o) => o.h.doc_no).join(', ')}`);
}

async function main() {
  note(`mode=${APPLY ? `APPLY (portal lane: ${LANE})` : 'PLAN (writes nothing)'}${ONLY_COMPANY != null ? ` company=${ONLY_COMPANY}` : ''}`);
  const companies = ONLY_COMPANY != null
    ? [ONLY_COMPANY]
    : (await sql`SELECT DISTINCT company_id FROM scm.mfg_sales_orders ORDER BY company_id`).map((r) => Number(r.company_id));

  const plans = new Map();
  for (const co of companies) {
    const read = await readOrderMargins(sql, co);
    const p = planCompanyMargins(read, LEFT_ALONE);
    plans.set(co, p);
    printPlan(co, read, p);
  }
  if (!APPLY) {
    note(`PLAN ONLY: nothing written. Re-run with MODE=apply CONFIRM="${CONFIRM_PHRASE}" PORTAL_LANE=background|normal.`);
    await sql.end({ timeout: 5 });
    return;
  }

  const written = new Map();
  for (const co of companies) {
    const { todo } = plans.get(co);
    const done = [];
    let lines = 0, heads = 0, laned = 0, failedChunks = 0;
    for (let i = 0; i < todo.length; i += CHUNK) {
      try {
        const r = await sql.begin((tx) => writeMarginChunk(tx, co, todo.slice(i, i + CHUNK), LANE));
        done.push(...r.audited);
        lines += r.lines; heads += r.heads; laned += r.laned;
      } catch (e) {
        failedChunks++;
        bad(`  company ${co} chunk ${i / CHUNK + 1}: rolled back, nothing of it written: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    written.set(co, done);
    const partial = done.filter((a) => !a.complete).length;
    note(`APPLIED company ${co}: orders written ${done.length} of ${todo.length} (${partial} only partly: edited since the plan); lines ${lines}; headers ${heads}; portal rows moved to the reconcile lane ${laned}; chunks rolled back ${failedChunks}`);
    if (failedChunks) process.exitCode = 1;
  }
  await sql.end({ timeout: 5 });

  // Re-read on a FRESH connection: every order written now reads as a save writes it.
  const check = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });
  try {
    note('===== VERIFIED ON A FRESH CONNECTION =====');
    for (const co of companies) {
      const fresh = await readOrderMargins(check, co);
      const byDoc = new Map(fresh.headers.map((h) => [h.doc_no, h]));
      const verified = (written.get(co) ?? []).filter((a) => a.complete);
      const off = [];
      for (const a of verified) {
        const h = byDoc.get(a.o.h.doc_no);
        const again = h ? planOrderMargins(h, fresh.linesByDoc.get(a.o.h.doc_no) ?? []) : { status: 'refused', why: 'gone' };
        const revenueIsTotal = h != null && Number(h.total_revenue_sen) === Number(h.local_total_sen);
        if (again.status !== 'ok' || again.header || again.lines.length || !revenueIsTotal) off.push(a.o.h.doc_no);
      }
      if (off.length) {
        bad(`  company ${co}: ${off.length} written order(s) do not read as a save writes them: ${off.slice(0, LIST_LIMIT).join(', ')}`);
        process.exitCode = 1;
      } else {
        note(`  company ${co}: all ${verified.length} fully written order(s) have line margin = total - cost, revenue = order total, margin = revenue - cost and its margin basis`);
      }
      note(`  company ${co}: a new plan finds ${planCompanyMargins(fresh, LEFT_ALONE).todo.length} order(s) to correct (orders edited since the plan)`);
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
