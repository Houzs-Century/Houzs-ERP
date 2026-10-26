#!/usr/bin/env node
/* close-commission-month.mjs — close one month of Event Commission through the
   app's own handler (routes/acc-event-commission.ts closeCommissionMonthHandler),
   as it would have been closed on the first day after it.

   WHY (owner 2026-10-26): 「9月的佣金我另外算了，所以不理9月的，我们当做10月开始」.
   September 2026 was paid outside the system, so it is taken as closed — after
   the 1–19 October back-fill (backfill-so-total-changes.mjs), so its figures
   are as at 30/9. Closed AT ITS END, not today: a payment keyed from 1 October
   but dated in September (19 of them, RM 52,187, moving September's commission
   RM 9,440.88 by fair on 14 orders — check-sep-after-close.mjs) is then not in
   September's figures; it comes back in October as September's adjustment,
   listed order by order, instead of being folded into September where nobody
   would see it. Everything else stands as it is today (fair links corrected in
   October stay corrected).

   HOW. Phase 1, always rolled back: inside a transaction the payments keyed on
   or after KEYED_BEFORE and dated in or before the month are taken out, the
   handler closes the month, and the row it wrote is read. Phase 2: that row
   is written as the month's close, with its audit entry, and October is read
   to show what it now carries.

   MODE=plan (default) runs phase 2 inside a transaction too and ROLLS BACK.
   MODE=apply with CONFIRM="CLOSE COMMISSION MONTH" keeps phase 2.
   Env: DATABASE_URL, COMPANY_ID (default 1), MONTH (default 2026-09),
        KEYED_BEFORE (default the month's end, 00:00 MYT the next day),
        CLOSED_BY (default "Baseline — September paid outside the system").
   RE-RUN: refused once the month is closed (the handler's 409). */
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { closeCommissionMonthHandler, eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply' || process.env.APPLY === '1';
const PHRASE = 'CLOSE COMMISSION MONTH';
const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = process.env.MONTH || '2026-09';
const CLOSED_BY = process.env.CLOSED_BY || 'Baseline — September paid outside the system';
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const next = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);
/* 00:00 MYT on the first day after the month = 16:00 UTC on its last day. */
const KEYED_BEFORE = process.env.KEYED_BEFORE || `${lastDay(MONTH)}T16:00:00Z`;

/* PostgREST runs every call in its own transaction; this script runs them all in
   ONE. A failed rpc (the audit pre-flight's probe, where the function is not
   deployed) would abort the whole transaction here and nowhere in production —
   so each rpc runs in its own savepoint, which a failure rolls back alone. */
const savepointRpc = (tx, sb) => {
  sb.rpc = async (name, args) => {
    try {
      return await tx.savepoint(async (sp) => {
        const r = await pgrestShim(sp, 'scm').rpc(name, args);
        if (r.error) throw Object.assign(new Error(r.error.message), { rpcError: r.error });
        return r;
      });
    } catch (e) {
      return { data: null, error: e.rpcError ?? { message: e instanceof Error ? e.message : String(e) } };
    }
  };
  return sb;
};
const ctxOf = (tx) => {
  const sb = savepointRpc(tx, pgrestShim(tx, 'scm'));
  return ({ query = {}, body = {} } = {}) => ({
    env: { DB: d1Compat(() => tx) },
    req: { query: (k) => query[k], json: async () => body, path: '/api/scm/acc-events/commission' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: null, name: CLOSED_BY } : undefined),
    json: (b, status = 200) => ({ body: b, status }),
  });
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error('MONTH must be YYYY-MM.'); process.exit(2); }
  if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) { console.error(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  class Rollback extends Error {}
  let row = null;
  try {
    /* Phase 1 — the month as it stood at its end, payments-wise. Always rolled back. */
    try {
      await sql.begin(async (tx) => {
        const late = await tx`DELETE FROM scm.mfg_sales_order_payments p USING scm.mfg_sales_orders o
          WHERE o.doc_no = p.so_doc_no AND o.company_id = ${CO} AND p.created_at >= ${KEYED_BEFORE} AND p.paid_at <= ${lastDay(MONTH)}
          RETURNING p.so_doc_no, p.amount_sen`;
        out(`phase 1: ${late.length} payment(s) keyed from ${KEYED_BEFORE} but dated by ${lastDay(MONTH)} left out (RM ${rm(late.reduce((s, p) => s + Number(p.amount_sen), 0))})`);
        const res = await closeCommissionMonthHandler(ctxOf(tx)({ body: { month: MONTH } }));
        out(`phase 1: close ${MONTH} (company ${CO}): HTTP ${res.status} ${res.status === 200 ? `by fair RM ${rm(res.body.totals.fair.totalSen)}, by SO date RM ${rm(res.body.totals.so_date.totalSen)}` : JSON.stringify(res.body)}`);
        if (res.status !== 200) throw new Error(res.body.message ?? 'refused');
        [row] = await tx`SELECT paid, carried, report_fair, report_so_date FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${MONTH}-01`}`;
        throw new Rollback();
      });
    } catch (e) { if (!(e instanceof Rollback)) throw e; }
    if (!row) throw new Error('phase 1 produced no close');

    /* Phase 2 — write that close, with its audit entry; read the next month. */
    await sql.begin(async (tx) => {
      await tx`INSERT INTO scm.event_commission_closes (company_id, month, closed_by, paid, carried, report_fair, report_so_date)
        VALUES (${CO}, ${`${MONTH}-01`}, ${CLOSED_BY}, ${tx.json(row.paid)}, ${tx.json(row.carried)}, ${tx.json(row.report_fair)}, ${tx.json(row.report_so_date)})`;
      await tx`INSERT INTO scm.entity_audit_log (entity_type, entity_id, entity_doc_no, company_id, action, actor_name_snapshot, field_changes, source, note)
        VALUES ('COMMISSION_MONTH', ${`${CO}:${MONTH}`}, ${MONTH}, ${CO}, 'POST', ${CLOSED_BY}, '[]'::jsonb, 'script',
          ${`Event Commission ${MONTH.replace('-', '/')} closed as at its end (payments keyed from ${KEYED_BEFORE} left to the next month): by fair RM ${(row.report_fair.totals.totalSen / 100).toFixed(2)}, by SO date RM ${(row.report_so_date.totals.totalSen / 100).toFixed(2)}`})`;
      for (const basis of ['fair', 'so_date']) {
        const nx = await eventCommissionHandler(ctxOf(tx)({ query: { from: `${next(MONTH)}-01`, to: lastDay(next(MONTH)), basis } }));
        out(`${next(MONTH)} by ${basis} then: total RM ${rm(nx.body.totals?.totalSen)}, ${MONTH} adjustments RM ${rm(nx.body.totals?.monthAdjustmentsSen)} on ${nx.body.monthAdjustments?.length ?? 0} orders`);
        for (const a of nx.body.monthAdjustments ?? []) out(`    ${basis} ${a.docNo} ${a.fairName} · ${a.salesperson ?? '-'} · paid ${rm(a.wasSen)} now ${rm(a.nowSen)} → ${rm(a.adjustmentSen)}`);
      }
      if (!APPLY) throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) { out('PLAN only — rolled back, nothing was kept. Re-run with MODE=apply and the CONFIRM phrase to close it.'); return; }
    throw e;
  } finally { await sql.end(); }
  const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const rows = await check`SELECT month, closed_at, closed_by FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month`;
  out(`APPLIED — closed months now: ${rows.map((r) => `${new Date(r.month).toISOString().slice(0, 7)} (${r.closed_by})`).join(', ')}`);
  await check.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
