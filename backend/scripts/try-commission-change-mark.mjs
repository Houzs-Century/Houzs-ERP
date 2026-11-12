#!/usr/bin/env node
// try-commission-change-mark.mjs — DRY RUN, ROLLED BACK. Reads October and
// November 2026 as they stand, then — inside one transaction — runs migration
// 20261112T1810 (the third mark on scm.event_commission_marks) against
// PRODUCTION and the app's own handlers on it (owner 2026-11-12: 「做 B：只是改价
// 不算」): marks the price change of one or two October orders not counted,
// refuses a second mark, a closed month and a mark with no month, reads October
// both ways and November again, undoes one — then ROLLS BACK. Nothing stays,
// whatever the outcome. The reads before the marks run OUTSIDE the transaction,
// so the table is locked only for the few reads after them.
// Prints HTTP statuses, yes / no, order numbers and counts only: the Actions
// log is public.
// Env: DATABASE_URL, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { d1Compat } from '../src/db/d1-compat.ts';
import { eventCommissionHandler, markCommissionOrderHandler, unmarkCommissionOrderHandler } from '../src/scm/routes/acc-event-commission.ts';

const CO = Number(process.env.COMPANY_ID || 1);
const MONTH = '2026-10';
const out = (s) => console.log(`ROW|${s}`);
const yes = (b) => (b ? 'yes' : 'NO');

/* PostgREST runs every call in its own transaction; inside ONE, a failed rpc
   (the audit pre-flight's probe) runs in its own savepoint. */
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

/** What a report pays each order: its fair commission and its earlier lines. */
const paidOf = (rep) => {
  const m = new Map();
  const add = (doc, sen) => m.set(doc, (m.get(doc) ?? 0) + sen);
  for (const f of rep.fairs ?? []) for (const s of f.sos) add(s.docNo, s.commissionSen);
  for (const a of rep.adjustments ?? []) add(a.docNo, a.commissionSen);
  return m;
};
const moved = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((d) => (a.get(d) ?? 0) !== (b.get(d) ?? 0));
const within = (docs, set) => docs.every((d) => set.includes(d));

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const text = readFileSync(new URL('../src/db/migrations-pg/20261112T1810_scm_event_commission_change_mark.sql', import.meta.url), 'utf8');
  const ctxOf = (db, sb) => ({ query = {}, body = {} } = {}) => ({
    env: { DB: d1Compat(() => db) },
    req: { query: (k) => query[k], json: async () => body, path: '/api/scm/acc-events/commission' },
    get: (k) => (k === 'companyId' ? CO : k === 'supabase' ? sb : k === 'houzsUser' ? { id: null, name: 'Dry run' } : undefined),
    json: (b, status = 200) => ({ body: b, status }),
  });
  const reader = (ctx) => async (from, to, basis = 'fair') => {
    const t = Date.now();
    const r = await eventCommissionHandler(ctx({ query: { from, to, basis } }));
    return { ...r, ms: Date.now() - t };
  };
  class Rollback extends Error {}
  try {
    /* ── Before: no lock, no transaction. ── */
    const read0 = reader(ctxOf(sql, pgrestShim(sql, 'scm')));
    const oct0 = await read0('2026-10-01', '2026-10-31');
    const octSo0 = await read0('2026-10-01', '2026-10-31', 'so_date');
    const nov0 = await read0('2026-11-01', '2026-11-30');
    out(`before: October by fair HTTP ${oct0.status} in ${oct0.ms} ms, by SO date HTTP ${octSo0.status} in ${octSo0.ms} ms, November HTTP ${nov0.status} in ${nov0.ms} ms`);
    if (oct0.status !== 200 || octSo0.status !== 200 || nov0.status !== 200) throw new Error('a report could not be read');
    const changed = oct0.body.changedOrders ?? [];
    const withEffect = changed.filter((o) => o.effectSen !== 0 && !o.mark && !o.changeMark);
    const inRange = withEffect.find((o) => o.part === 'range');
    const earlier = withEffect.find((o) => o.part === 'earlier');
    const targets = [inRange, earlier].filter(Boolean);
    out(`October changed orders: ${changed.length}; with an effect: ${withEffect.length}; picked one of this month's fairs: ${yes(!!inRange)}, one of an earlier fair: ${yes(!!earlier)}`);
    if (targets.length === 0) throw new Error('no changed order with an effect to try');
    const docs = targets.map((o) => o.docNo);
    out(`trying: ${docs.join(', ')}`);

    await sql.begin(async (tx) => {
      const rowsBefore = (await tx`SELECT count(*)::int AS n FROM scm.event_commission_marks`)[0].n;
      await tx.unsafe(text);
      const cons = await tx`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'scm.event_commission_marks'::regclass AND contype = 'c' ORDER BY conname`;
      const kind = cons.find((c) => c.conname === 'event_commission_marks_kind');
      const month = cons.find((c) => c.conname === 'event_commission_marks_month');
      const firstDay = cons.filter((c) => /EXTRACT\(day/i.test(c.def));
      const idx = await tx`SELECT indexname FROM pg_indexes WHERE schemaname = 'scm' AND tablename = 'event_commission_marks' ORDER BY indexname`;
      out(`checks on the table: ${cons.length} (${cons.map((c) => c.conname).join(', ')}); the kind check allows exclude_change: ${yes(!!kind && kind.def.includes('exclude_change'))}; the month check ties a month to every kind but exclude: ${yes(!!month && /exclude/.test(month.def) && !/defer/.test(month.def))}; first-of-month check kept: ${yes(firstDay.length === 1)}`);
      out(`indexes: ${idx.map((r) => r.indexname).join(', ')}; rows already there kept: ${yes((await tx`SELECT count(*)::int AS n FROM scm.event_commission_marks`)[0].n === rowsBefore)} (${rowsBefore})`);

      const sb = savepointRpc(tx, pgrestShim(tx, 'scm'));
      const ctx = ctxOf(tx, sb);
      const read = reader(ctx);
      const mark = (body) => markCommissionOrderHandler(ctx({ body }));
      const history = async () => (await tx`SELECT count(*)::int AS n FROM scm.mfg_so_audit_log WHERE so_doc_no IN ${tx(docs)}`)[0].n;
      const historyBefore = await history();

      const marks = [];
      for (const doc of docs) marks.push(await mark({ docNo: doc, kind: 'exclude_change', month: MONTH, reason: 'dry run' }));
      out(`mark the price change not counted: ${marks.map((m, i) => `${docs[i]} HTTP ${m.status}`).join('; ')}`);
      /* A refused insert (23505) aborts a transaction; PostgREST runs each request
         in its own, so the second mark runs in a savepoint of its own. */
      let twice = null;
      try {
        await tx.savepoint(async (sp) => {
          twice = await markCommissionOrderHandler(ctxOf(sp, savepointRpc(sp, pgrestShim(sp, 'scm')))({ body: { docNo: docs[0], kind: 'exclude_change', month: MONTH } }));
          if (twice.status >= 400) throw new Error('undo this savepoint');
        });
      } catch { /* the savepoint rolled back; twice holds the answer */ }
      const closedMonth = await mark({ docNo: docs[0], kind: 'exclude_change', month: '2026-09' });
      const noMonth = await mark({ docNo: docs[0], kind: 'exclude_change' });
      out(`twice: HTTP ${twice.status} ${twice.body.error}; closed 2026/09: HTTP ${closedMonth.status} ${closedMonth.body.error}; no month: HTTP ${noMonth.status} ${noMonth.body.error}`);

      const check = (label, before, after) => {
        const p0 = paidOf(before.body);
        const p1 = paidOf(after.body);
        const movedDocs = moved(p0, p1);
        const listed = (doc) => (after.body.marked ?? []).find((m) => m.docNo === doc && m.mark.kind === 'exclude_change');
        const row = (doc) => (after.body.changedOrders ?? []).find((o) => o.docNo === doc);
        const row0 = (doc) => (before.body.changedOrders ?? []).find((o) => o.docNo === doc);
        const here = docs.filter((d) => row0(d) != null);
        const exact = here.every((d) => listed(d) != null && (p0.get(d) ?? 0) - (p1.get(d) ?? 0) === listed(d).commissionSen);
        const near = here.every((d) => listed(d) != null && Math.abs(listed(d).commissionSen - row0(d).effectSen) <= 2);
        const sum = here.reduce((t, d) => t + (listed(d)?.commissionSen ?? 0), 0);
        const tagged = here.every((d) => row(d)?.effectSen === 0 && row(d)?.changeMark?.kind === 'exclude_change' && row(d)?.amendedSen === row0(d).amendedSen);
        const stillEarn = here.every((d) => (p0.get(d) ?? 0) === 0 || (p1.get(d) ?? 0) !== 0 || row0(d).originalSen === 0);
        out(`${label}: HTTP ${after.status} in ${after.ms} ms; marked orders on it: ${here.length}; only they moved: ${yes(within(movedDocs, docs))} (${movedDocs.length}); each by exactly what is listed: ${yes(exact)}; listed within 2 sen of the effect shown before: ${yes(near)}; total down by exactly the listed sum: ${yes(before.body.totals.totalSen - after.body.totals.totalSen === sum)}; rows keep their amounts, effect 0, Undo mark: ${yes(tagged)}; the orders still earn: ${yes(stillEarn)}`);
      };
      check('October by fair', oct0, await read('2026-10-01', '2026-10-31'));
      check('October by SO date', octSo0, await read('2026-10-01', '2026-10-31', 'so_date'));
      const nov1 = await read('2026-11-01', '2026-11-30');
      const novMoved = moved(paidOf(nov0.body), paidOf(nov1.body));
      out(`November: HTTP ${nov1.status} in ${nov1.ms} ms; orders that moved there: ${novMoved.length}; none but the marked ones: ${yes(within(novMoved, docs))}; total unchanged or moved only by them: ${yes(novMoved.length > 0 || nov0.body.totals.totalSen === nov1.body.totals.totalSen)}`);

      const undo = await unmarkCommissionOrderHandler(ctx({ body: { id: marks[0].body.mark?.id } }));
      const back = await read('2026-10-01', '2026-10-31');
      const p0 = paidOf(oct0.body);
      const pb = paidOf(back.body);
      out(`undo ${docs[0]}: HTTP ${undo.status}; it earns what it did before: ${yes((p0.get(docs[0]) ?? 0) === (pb.get(docs[0]) ?? 0))}; its row has its effect again: ${yes((back.body.changedOrders ?? []).find((o) => o.docNo === docs[0])?.effectSen === targets[0].effectSen)}`);
      out(`order History rows written: ${(await history()) - historyBefore}`);
      throw new Rollback('dry run');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    out('ROLLED BACK — nothing kept');
  } finally { await sql.end(); }
}
main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 400)); process.exit(1); });
