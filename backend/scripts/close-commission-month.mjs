#!/usr/bin/env node
/* close-commission-month.mjs — close one month of Event Commission through the
   app's own handler (routes/acc-event-commission.ts closeCommissionMonthHandler),
   the same as Finance pressing "Close <month>" on the page.

   WHY (owner 2026-10-26): 「9月的佣金我另外算了，所以不理9月的，我们当做10月开始」.
   September 2026 was paid outside the system, so it is closed as it stands —
   after the 1–19 October back-fill (backfill-so-total-changes.mjs), so its
   figures are as at 30/9 — and from then on anything that changes for its
   orders is paid in October as an adjustment instead of moving September.

   MODE=plan (default) closes it inside a transaction, prints what was kept and
   what October would then carry, and ROLLS BACK.
   MODE=apply with CONFIRM="CLOSE COMMISSION MONTH" closes it for real and reads
   the row back on a fresh connection.
   Env: DATABASE_URL, COMPANY_ID (default 1), MONTH (default 2026-09),
        CLOSED_BY (default "Baseline — September paid outside the system").
   RE-RUN: the handler refuses a month already closed (409). */
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
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const next = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 7);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error('MONTH must be YYYY-MM.'); process.exit(2); }
  if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) { console.error(`CONFIRM must be exactly "${PHRASE}" to apply. Nothing was written.`); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  class Rollback extends Error {}
  try {
    await sql.begin(async (tx) => {
      const sb = savepointRpc(tx, pgrestShim(tx, 'scm'));
      const ctx = ({ query = {}, body = {} } = {}) => ({
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => query[k], json: async () => body, path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: null, name: CLOSED_BY } : undefined),
        json: (b, status = 200) => ({ body: b, status }),
      });
      const res = await closeCommissionMonthHandler(ctx({ body: { month: MONTH } }));
      out(`close ${MONTH} (company ${CO}): HTTP ${res.status} ${res.status === 200 ? `by fair RM ${rm(res.body.totals.fair.totalSen)}, by SO date RM ${rm(res.body.totals.so_date.totalSen)}` : JSON.stringify(res.body)}`);
      if (res.status !== 200) throw new Error(res.body.message ?? 'refused');
      for (const basis of ['fair', 'so_date']) {
        const nx = await eventCommissionHandler(ctx({ query: { from: `${next(MONTH)}-01`, to: lastDay(next(MONTH)), basis } }));
        out(`${next(MONTH)} by ${basis} then: total RM ${rm(nx.body.totals?.totalSen)}, closed-month adjustments RM ${rm(nx.body.totals?.monthAdjustmentsSen)} on ${nx.body.monthAdjustments?.length ?? 0} orders`);
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
