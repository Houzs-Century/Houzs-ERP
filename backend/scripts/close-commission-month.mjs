#!/usr/bin/env node
// close-commission-month.mjs — Event Commission's "Close <month>" (关月) pressed
// for Finance, through the page's own handler (POST /commission/close): the
// month's report is stored as it stands, by fair and by SO date, with what it
// paid for each order. From then on the month is served as it was closed, and
// what changes for its orders later is paid in the next open month as an
// adjustment. Reopen stays on the page (the latest closed month only).
//
// Owner 2026-11-13: 「9月的如果你确定就帮我lock 起来吧」.
//
// MODE=plan (default) says whether the month can be closed (not closed yet, in
// order, ended) and how many orders its two reports carry, then REHEARSES the
// close inside a transaction that is always rolled back — so a refusal or a
// wrong stored shape shows before the real run; nothing is written.
// MODE=apply with CONFIRM="CLOSE COMMISSION MONTH" calls the handler INSIDE ONE
// TRANSACTION and reads the stored row back before committing: both reports and
// both paid lists must be JSON objects with their totals — else the transaction
// is rolled back and nothing is written. Then it re-reads on a fresh connection
// and exits 1 if the month is not there in that shape.
// Prints the month, counts and who closed it — no amounts (the Actions log is
// public).
//
// RE-RUN: a month already closed is refused by the handler (already_closed), so
// a second run writes nothing.
// Env: DATABASE_URL, MONTH (YYYY-MM), ACTOR, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { closeCommissionMonthHandler, eventCommissionHandler } from '../src/scm/routes/acc-event-commission.ts';

const PHRASE = 'CLOSE COMMISSION MONTH';
const MODE = String(process.env.MODE || 'plan').trim().toLowerCase();
const APPLY = MODE === 'apply';
if (APPLY && (process.env.CONFIRM ?? '').trim() !== PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${PHRASE}" — refusing, nothing was written.`);
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = String(process.env.MONTH ?? '').trim();
const ACTOR = String(process.env.ACTOR ?? '').trim() || 'Finance (by script)';
const say = (s) => console.log(s);

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
/* Inside the one transaction a statement that fails aborts everything after it.
   The handler's audit pre-flight (entity-audit.ts assertAuditWritable) calls the
   probe function scm.entity_audit_writable and, when it is not there, falls back
   to a plain read of the audit log — a failure it expects. The first apply
   (2026-11-13) ran the probe on the transaction itself: the probe failed, the
   transaction was aborted, the fallback read was refused and the close answered
   409 audit_trail_unavailable (nothing was written). So an rpc() runs in a
   SAVEPOINT here: when it fails only the savepoint is rolled back, the error is
   handed back PostgREST-style, and the pre-flight goes on as it does in the app. */
const rpcInSavepoint = (tx) => async (name, args) => {
  try {
    return await tx.savepoint(async (sp) => {
      const r = await pgrestShim(sp, 'scm').rpc(name, args);
      if (r.error) throw new Error(r.error.message);
      return r;
    });
  } catch (e) {
    return { data: null, error: { message: String(e?.message ?? e) } };
  }
};
const ctxOf = (db, { body = {}, query = {}, inTransaction = false } = {}) => {
  const shim = pgrestShim(db, 'scm');
  const sb = !inTransaction ? shim : new Proxy(shim, {
    get(target, prop) {
      if (prop === 'rpc') return rpcInSavepoint(db);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return {
    env: { DB: d1Compat(() => db) },
    req: { json: async () => body, query: (k) => query[k], path: '/api/scm/acc-events/commission/close' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { name: ACTOR } : undefined),
    json: (b, status = 200) => ({ body: b, status }),
  };
};
const closesOf = (db) => db`
  SELECT to_char(month, 'YYYY-MM') AS ym, closed_by, closed_at FROM scm.event_commission_closes WHERE company_id = ${CO} ORDER BY month`;
/** The stored month's shape: the two reports and the two paid lists, as JSON objects with their totals. */
const shapeOf = async (db) => {
  const [row] = await db`
    SELECT closed_by,
           jsonb_typeof(paid) AS paid, jsonb_typeof(paid -> 'fair') AS paid_fair, jsonb_typeof(paid -> 'so_date') AS paid_so,
           jsonb_typeof(carried) AS carried, jsonb_typeof(report_fair) AS rf, jsonb_typeof(report_so_date) AS rs,
           jsonb_typeof(report_fair -> 'fairs') AS rf_fairs, jsonb_typeof(report_so_date -> 'fairs') AS rs_fairs,
           (report_fair -> 'totals' ->> 'totalSen') IS NOT NULL AS rf_total, (report_so_date -> 'totals' ->> 'totalSen') IS NOT NULL AS rs_total,
           report_fair ->> 'basis' AS rf_basis, report_so_date ->> 'basis' AS rs_basis,
           (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(paid -> 'fair') = 'object' THEN paid -> 'fair' ELSE '{}'::jsonb END))::int AS paid_fair_orders,
           (SELECT count(*) FROM jsonb_object_keys(CASE WHEN jsonb_typeof(paid -> 'so_date') = 'object' THEN paid -> 'so_date' ELSE '{}'::jsonb END))::int AS paid_so_orders
      FROM scm.event_commission_closes WHERE company_id = ${CO} AND month = ${`${MONTH}-01`}::date`;
  if (!row) return { ok: false, why: 'no row for the month' };
  const ok = row.paid === 'object' && row.paid_fair === 'object' && row.paid_so === 'object' && row.carried === 'object'
    && row.rf === 'object' && row.rs === 'object' && row.rf_fairs === 'array' && row.rs_fairs === 'array'
    && row.rf_total === true && row.rs_total === true && row.rf_basis === 'fair' && row.rs_basis === 'so_date';
  return { ok, why: ok ? '' : 'the stored reports are not JSON objects with their totals', row };
};

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) { console.error('MONTH=YYYY-MM is required — nothing was written.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    say(`close-commission-month   company ${CO}   month ${MONTH}   mode ${APPLY ? 'APPLY' : 'PLAN'}`);
    const closes = await closesOf(sql);
    say(`   closed months now: ${closes.map((k) => k.ym).join(', ') || 'none'}`);
    if (closes.some((k) => k.ym === MONTH)) { say(`   ${MONTH} is already closed (by ${closes.find((k) => k.ym === MONTH).closed_by ?? '-'}) — nothing to do.`); return; }

    /* What the month's two reports carry now — counts only. Read only. */
    await sql.begin('read only', async (tx) => {
      for (const basis of ['fair', 'so_date']) {
        const res = await eventCommissionHandler(ctxOf(tx, { query: { from: `${MONTH}-01`, to: lastDay(MONTH), basis } }));
        if (res.status !== 200) { say(`   ${basis}: the report could not be read (${res.status} ${res.body?.error ?? ''})`); continue; }
        const r = res.body;
        say(`   ${basis}: ${r.fairs.reduce((n, f) => n + f.sos.length, 0)} order(s) in the range, ${(r.earlierOrders ?? []).length} earlier order line(s), ${(r.changedOrders ?? []).length} upsale / drop row(s), ${(r.marked ?? []).length} marked`);
      }
    });
    if (!APPLY) {
      /* The close itself, rehearsed: run inside a transaction that is ALWAYS
         rolled back, so a refusal (the audit pre-flight, the order of months) or
         a wrong stored shape shows here, before the real run, and nothing stays. */
      const UNDO = Symbol('rehearsal');
      let rehearsal = 'not run';
      try {
        await sql.begin(async (tx) => {
          const res = await closeCommissionMonthHandler(ctxOf(tx, { body: { month: MONTH }, inTransaction: true }));
          if (res.status !== 200) { rehearsal = `would be REFUSED (${res.status} ${res.body?.error ?? ''})`; throw UNDO; }
          const shape = await shapeOf(tx);
          rehearsal = shape.ok
            ? `would go through — stored in full, ${shape.row.paid_fair_orders} order(s) paid by fair and ${shape.row.paid_so_orders} by SO date`
            : `would be stored in the WRONG shape (${shape.why})`;
          throw UNDO;
        });
      } catch (e) {
        if (e !== UNDO) rehearsal = `failed (${String(e?.message ?? e).slice(0, 160)})`;
      }
      const still = await closesOf(sql);
      say(`   rehearsal, rolled back: ${rehearsal}`);
      say(`   closed months after the rehearsal: ${still.map((k) => k.ym).join(', ') || 'none'}`);
      say(`\nNothing written. To write: MODE=apply CONFIRM="${PHRASE}"`);
      return;
    }

    await sql.begin(async (tx) => {
      const res = await closeCommissionMonthHandler(ctxOf(tx, { body: { month: MONTH }, inTransaction: true }));
      if (res.status !== 200) throw new Error(`the close was refused (${res.status} ${res.body?.error ?? ''}) — nothing was written`);
      const shape = await shapeOf(tx);
      if (!shape.ok) throw new Error(`${shape.why} — rolled back, nothing was written`);
    });
    say(`\n   ${MONTH} closed`);

    const check = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
    try {
      const shape = await shapeOf(check);
      const after = await closesOf(check);
      say(`Verified on a fresh connection: closed months ${after.map((k) => k.ym).join(', ') || 'none'}; ${MONTH} ${shape.ok ? `is stored in full, closed by ${shape.row.closed_by ?? '-'}, ${shape.row.paid_fair_orders} order(s) paid by fair and ${shape.row.paid_so_orders} by SO date` : `NOT AS EXPECTED (${shape.why})`}`);
      if (!shape.ok) process.exitCode = 1;
    } finally { await check.end(); }
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 300)); process.exit(1); });
