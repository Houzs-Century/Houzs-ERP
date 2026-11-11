#!/usr/bin/env node
// try-previous-records.mjs — a ROLLED-BACK production trial of the previous-record doors
// (owner 2026-11-11: 我检查确定后，就直接说这个是之前record，我哪里都不会take-in).
// One transaction that always rolls back. It makes the migration's table inside the
// transaction, then, through the real handlers on the company's real payments, marks a
// few — AutoCount ones on Merchant Recon's card payments not reported yet, soft-launch
// ones on Payments not matched yet, one counted in the books, one a merchant line holds,
// one on the Cash Flow's AutoCount line — reads the three lists before and after, lists
// the marks, undoes them. A fresh read after the rollback proves nothing stayed.
// Prints counts and yes/no only — this repository's Actions logs are public. MODE=plan only.
// Env: DATABASE_URL, COMPANY_ID (default 1).
import './lib/public-log-guard.mjs';
import fs from 'node:fs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { previousPaymentsList, previousPaymentsMark, previousPaymentsUndo } from '../src/scm/routes/accounting-previous-payments.ts';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';
import { settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';
import { loadAutoCountReceipts } from '../src/acc/autocount-receipts.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if (process.env.APPLY === '1' || (process.env.MODE && process.env.MODE !== 'plan')) { console.error('This trial is plan-only: it always rolls back.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 1);
const MIGRATION = new URL('../src/db/migrations-pg/20261111T0400_acc_previous_payment_records.sql', import.meta.url);
const BY = 'rolled-back trial';
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const bad = [];
const check = (ok, what) => { row(ok ? 'ok ' : 'BAD', what); if (!ok) bad.push(what); };
class Rollback extends Error {}
const key = (s, id) => `${s}:${id}`;
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const back = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

try {
  await sql.begin(async (tx) => {
    const [had] = await tx`SELECT to_regclass('scm.acc_previous_payment_records') IS NOT NULL AS yes`;
    row('TABLE', `already on production ${had.yes ? 'yes' : 'no'}`);
    if (!had.yes) await tx.unsafe(fs.readFileSync(MIGRATION, 'utf8'));

    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e).slice(0, 400) }, 500));
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
      c.set('houzsUser', { name: BY, permissions_set: ['*', 'scm.payment_voucher.post'] });
      await next();
    });
    app.get('/w', settlementWatchlist);
    app.get('/u', unmatchedPaymentsHandler);
    app.get('/prev', previousPaymentsList);
    app.post('/prev', previousPaymentsMark);
    app.post('/prev/undo', previousPaymentsUndo);
    const post = async (path, payments) => {
      const res = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payments }) });
      return { status: res.status, body: await res.json() };
    };
    /* What each list shows, as keys. */
    const lists = async () => {
      const w = await (await app.request('/w')).json();
      const u = await (await app.request(`/u?from=${back(180)}&to=${TODAY}`)).json();
      const a = await loadAutoCountReceipts(sb, CO, '2026-09-01', TODAY);
      if (!a.ok) throw new Error(`AutoCount line: ${a.reason}`);
      return {
        watch: new Set((w.recordedNotArrived ?? []).map((p) => key(p.source, p.id))),
        unmatched: new Set((u.rows ?? []).map((p) => key(p.source, p.paymentId))),
        autocount: new Set(a.payments.map((p) => key('SOPAY', p.id))),
        unmatchedRows: u.rows ?? [],
      };
    };
    const before = await lists();
    row('BEFORE', `watch list ${before.watch.size}`, `payments not matched ${before.unmatched.size}`, `AutoCount line ${before.autocount.size}`);

    /* The trial's payments, each kind the rule decides. */
    const [{ day: start } = { day: null }] = await tx`SELECT to_char(books_start_date, 'YYYY-MM-DD') AS day FROM scm.acc_company_settings WHERE company_id = ${CO}`;
    const watchIds = [...before.watch].map((k) => k.split(':')[1]);
    const imported = watchIds.length === 0 ? [] : (await tx`
      SELECT id::text AS id FROM scm.mfg_sales_order_payments
       WHERE company_id = ${CO} AND method = 'imported' AND id::text IN ${tx(watchIds)} ORDER BY id LIMIT 3`).map((r) => ({ source: 'SOPAY', id: r.id }));
    const soft = before.unmatchedRows.filter((r) => start && r.paidOn < start).slice(0, 2).map((r) => ({ source: r.source, id: r.paymentId }));
    const booked = before.unmatchedRows.filter((r) => start && r.paidOn >= start && r.jeNo).slice(0, 1).map((r) => ({ source: r.source, id: r.paymentId }));
    const held = (await tx`SELECT payment_source, payment_id FROM scm.acc_settlement_matches WHERE company_id = ${CO} ORDER BY id LIMIT 1`)
      .map((r) => ({ source: r.payment_source, id: r.payment_id }));
    const ac = [...before.autocount].slice(0, 1).map((k) => ({ source: 'SOPAY', id: k.split(':')[1] }));
    row('PICKED', `AutoCount on the watch list ${imported.length}`, `soft launch on the list ${soft.length}`, `counted in the books ${booked.length}`,
      `held by a merchant line ${held.length}`, `on the AutoCount line ${ac.length}`);

    const asked = [...imported, ...soft, ...booked, ...held, ...ac];
    const marked = await post('/prev', asked);
    check(marked.status === 200, `the mark answers 200 (got ${marked.status}${marked.body.error ? ` ${marked.body.error}` : ''})`);
    const refused = marked.body.refused ?? [];
    const refusedBy = (reason) => refused.filter((r) => r.reason === reason).map((r) => key(r.source, r.id));
    const refusedKeys = new Set(refused.map((r) => key(r.source, r.id)));
    const expectMarked = new Set(asked.map((r) => key(r.source, r.id)).filter((k) => !refusedKeys.has(k)));
    row('ANSWER', `marked ${marked.body.marked}`, `refused ${refused.length}`,
      `reasons ${[...new Set(refused.map((r) => r.reason))].map((x) => `${x} ${refusedBy(x).length}`).join(', ') || '—'}`);
    check(marked.body.marked === expectMarked.size, `marked ${marked.body.marked} = asked less refused (${expectMarked.size})`);
    check([...imported, ...ac].every((r) => expectMarked.has(key(r.source, r.id))), `the AutoCount ones are marked (${imported.length + ac.length})`);
    check(soft.length === 0 || soft.some((r) => expectMarked.has(key(r.source, r.id))), `soft-launch ones are marked (${soft.filter((r) => expectMarked.has(key(r.source, r.id))).length} of ${soft.length})`);
    check(booked.every((r) => refusedBy('in_the_books').includes(key(r.source, r.id))), `the one counted in the books is refused (${booked.length})`);
    check(held.every((r) => refusedBy('merchant_line').includes(key(r.source, r.id))), `the one a merchant line holds is refused (${held.length})`);
    check(refused.every((r) => r.message.length > 0 && r.message.length < 200), 'each refusal has its sentence');

    const after = await lists();
    const gone = (name) => [...expectMarked].filter((k) => before[name].has(k));
    for (const name of ['watch', 'unmatched', 'autocount']) {
      const leftOver = gone(name).filter((k) => after[name].has(k)).length;
      check(leftOver === 0 && after[name].size === before[name].size - gone(name).length,
        `${name}: ${gone(name).length} marked gone, nothing else moved (${before[name].size} → ${after[name].size})`);
    }
    const listed = await (await app.request('/prev')).json();
    check((listed.rows ?? []).length === expectMarked.size && (listed.rows ?? []).every((r) => r.markedBy === BY), `the list holds the ${expectMarked.size} marked, by the trial`);

    const undone = await post('/prev/undo', [...expectMarked].map((k) => ({ source: k.split(':')[0], id: k.split(':')[1] })));
    check(undone.body.undone === expectMarked.size, `undo put back ${undone.body.undone}`);
    const again = await lists();
    for (const name of ['watch', 'unmatched', 'autocount']) check(again[name].size === before[name].size, `${name}: back to ${before[name].size} after undo`);
    throw new Rollback('always');
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}
const [left] = await sql`SELECT to_regclass('scm.acc_previous_payment_records') IS NOT NULL AS yes`;
const stayed = left.yes ? (await sql`SELECT count(*)::int AS n FROM scm.acc_previous_payment_records WHERE marked_by = ${BY}`)[0].n : 0;
check(stayed === 0, `a fresh read: ${stayed} trial marks stayed; table there ${left.yes ? 'yes' : 'no'}`);
console.log(bad.length === 0 ? 'TRIAL OK — rolled back, nothing written.' : `TRIAL FOUND ${bad.length} PROBLEM(S) — rolled back, nothing written.`);
await sql.end();
if (bad.length > 0) process.exit(1);
