#!/usr/bin/env node
// try-month-close.mjs — DRY RUN, ROLLED BACK. Runs migration 20261026T1700
// (scm.event_commission_closes) against PRODUCTION inside one transaction, then
// the app's own handlers on it: close September 2026 for Houzs (both bases),
// read September back as closed, read October with September's adjustments,
// refuse an out-of-order close, reopen September — then ROLLS BACK. Nothing
// stays, whatever the outcome. Env: DATABASE_URL, COMPANY_ID (default 1),
// MONTH (default 2026-09).
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import {
  closeCommissionMonthHandler, eventCommissionHandler, reopenCommissionMonthHandler,
} from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = process.env.MONTH || '2026-09';
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
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('./data/try-20261026T1700.sql', import.meta.url), 'utf8');
  class Rollback extends Error {}
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      const cols = await tx`SELECT column_name AS c, data_type AS d, is_nullable AS n FROM information_schema.columns
        WHERE table_schema = 'scm' AND table_name = 'event_commission_closes' ORDER BY ordinal_position`;
      out(`columns: ${cols.map((r) => `${r.c} ${r.d}${r.n === 'NO' ? ' not null' : ''}`).join(', ')}`);
      const grants = await tx`SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) AS p FROM information_schema.role_table_grants
        WHERE table_schema = 'scm' AND grantee = 'service_role' AND table_name = 'event_commission_closes'`;
      out(`service_role: ${grants[0]?.p ?? 'NONE'}`);

      const sb = savepointRpc(tx, pgrestShim(tx, 'scm'));
      const ctx = ({ query = {}, body = {} } = {}) => ({
        env: { DB: d1Compat(() => tx) },
        req: { query: (k) => query[k], json: async () => body, path: '/api/scm/acc-events/commission' },
        get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: null, name: 'Dry run' } : undefined),
        json: (b, status = 200) => ({ body: b, status }),
      });
      const t0 = Date.now();
      const closed = await closeCommissionMonthHandler(ctx({ body: { month: MONTH } }));
      out(`close ${MONTH}: HTTP ${closed.status} in ${Date.now() - t0} ms — ${JSON.stringify(closed.body).slice(0, 400)}`);
      if (closed.status !== 200) throw new Error('close refused');
      const [row] = await tx`SELECT month, closed_by, octet_length(report_fair::text) AS fair_bytes, octet_length(report_so_date::text) AS so_bytes,
          (SELECT count(*) FROM jsonb_object_keys(paid->'fair'))::int AS paid_fair, (SELECT count(*) FROM jsonb_object_keys(paid->'so_date'))::int AS paid_so
        FROM scm.event_commission_closes WHERE company_id = ${CO}`;
      out(`stored: month ${String(row.month).slice(0, 10)}, by ${row.closed_by}, report ${row.fair_bytes} + ${row.so_bytes} bytes, paid orders ${row.paid_fair} by fair / ${row.paid_so} by SO date`);

      for (const basis of ['fair', 'so_date']) {
        const sep = await eventCommissionHandler(ctx({ query: { from: `${MONTH}-01`, to: lastDay(MONTH), basis } }));
        out(`read ${MONTH} by ${basis}: HTTP ${sep.status}, closed ${JSON.stringify(sep.body.closed)}, total RM ${rm(sep.body.totals?.totalSen)}, closes ${JSON.stringify(sep.body.closes)}`);
        const t1 = Date.now();
        const oct = await eventCommissionHandler(ctx({ query: { from: `${next(MONTH)}-01`, to: lastDay(next(MONTH)), basis } }));
        out(`read ${next(MONTH)} by ${basis}: HTTP ${oct.status} in ${Date.now() - t1} ms, total RM ${rm(oct.body.totals?.totalSen)} (adjustments for closed months RM ${rm(oct.body.totals?.monthAdjustmentsSen)}, ${oct.body.monthAdjustments?.length ?? '?'} orders)`);
        for (const a of (oct.body.monthAdjustments ?? []).slice(0, 10)) out(`    ${a.month} ${a.docNo} ${a.fairName} · paid ${rm(a.wasSen)} now ${rm(a.nowSen)} → ${rm(a.adjustmentSen)}`);
      }
      const early = await closeCommissionMonthHandler(ctx({ body: { month: next(next(MONTH)) } }));
      out(`close ${next(next(MONTH))} out of order: HTTP ${early.status} ${early.body.error} — ${early.body.message}`);
      const again = await closeCommissionMonthHandler(ctx({ body: { month: MONTH } }));
      out(`close ${MONTH} again: HTTP ${again.status} ${again.body.error}`);
      const reopened = await reopenCommissionMonthHandler(ctx({ body: { month: MONTH } }));
      out(`reopen ${MONTH}: HTTP ${reopened.status} ${JSON.stringify(reopened.body)}`);
      const audit = await tx`SELECT action, entity_id, actor_name_snapshot, note FROM scm.entity_audit_log WHERE entity_type = 'COMMISSION_MONTH' ORDER BY created_at`;
      for (const a of audit) out(`audit ${a.action} ${a.entity_id} by ${a.actor_name_snapshot}: ${a.note}`);
      throw new Rollback();
    });
  } catch (e) {
    if (e instanceof Rollback) out('ROLLED BACK — the migration and the close / read / reopen paths work on production data; nothing was kept.');
    else { out(`FAILED (rolled back): ${e.message}`); process.exitCode = 1; }
  } finally { await sql.end(); }
  const after = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const [still] = await after`SELECT to_regclass('scm.event_commission_closes') IS NOT NULL AS t,
    (SELECT count(*)::int FROM scm.entity_audit_log WHERE entity_type = 'COMMISSION_MONTH') AS audit`;
  out(`after rollback: table exists ${still.t}, COMMISSION_MONTH audit rows ${still.audit}`);
  await after.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
