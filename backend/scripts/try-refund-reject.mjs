#!/usr/bin/env node
// try-refund-reject.mjs: a ROLLED-BACK production trial. Owner 2026-11-06: 「如果他们
// request refund，我 reject 后不行？」. Every step runs in ONE transaction that always
// rolls back, through the app's real routes, as real users: a salesperson raises a refund
// on a real order, a Finance Executive and the Owner reject it, the order's money and the
// request are read back, another is raised. A fresh read then proves nothing stayed.
// MODE=plan only (an apply is refused).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { paymentRequests } from '../src/scm/routes/payment-requests.ts';
import { soMoneyHandler, soMoneyRefundHandler } from '../src/scm/routes/so-money-routes.ts';
import { ordersWithMoney } from '../src/scm/lib/so-money.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1' || (process.env.MODE && process.env.MODE !== 'plan')) { console.error('This trial is plan-only: it always rolls back.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bad = [];
const check = (ok, what) => { out(`${ok ? 'ok ' : 'BAD'} ${what}`); if (!ok) bad.push(what); };
const REASON = 'TRIAL rolled back: customer wants the money back';
class Rollback extends Error {}

const perms = (r) => { try { const p = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions; return Array.isArray(p) ? p : []; } catch { return []; } };

function appFor(tx, co, code, user) {
  const sb = pgrestShim(tx, 'scm');
  /* The route's preflight only asks whether the audit log can be written; the insert that follows really writes it, inside this transaction. */
  const realRpc = sb.rpc.bind(sb);
  sb.rpc = async (name, args) => (name === 'entity_audit_writable' ? { data: true, error: null } : realRpc(name, args));
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e).slice(0, 500) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase', sb);
    c.set('companyId', co);
    c.set('user', { id: user.auth_user_id ?? null });
    c.set('houzsUser', user);
    c.set('allowedCompanyIds', [co]);
    c.set('companies', [{ id: co, code }]);
    c.set('companyCode', code);
    await next();
  });
  app.route('/payment-requests', paymentRequests);
  app.get('/mfg-sales-orders/:docNo/money', soMoneyHandler);
  app.post('/mfg-sales-orders/:docNo/money/refund', soMoneyRefundHandler);
  return async (path, method = 'GET', body) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
    return { status: res.status, body: json };
  };
}

const ask = (amountSen) => ({ amountSen, reason: REASON, bankName: 'TRIAL BANK', bankAccountNo: '1234567890', bankAccountName: 'TRIAL CUSTOMER' });

async function trial(tx, co, code, people) {
  out(`== company ${co} (${code})`);
  const existing = await tx`SELECT request_no, status, amount_sen, refund_source_doc_no, requested_by_name, finance_note, decided_by, created_at FROM scm.acc_payment_requests WHERE company_id = ${co} AND refund_source_doc_no IS NOT NULL ORDER BY created_at`;
  const tally = {};
  for (const r of existing) tally[r.status] = (tally[r.status] ?? 0) + 1;
  out(`refund requests on the books: ${existing.length} ${JSON.stringify(tally)}`);
  for (const r of existing.slice(-8)) out(`   ${r.request_no} ${r.status} ${rm(r.amount_sen)} ${r.refund_source_doc_no} by ${r.requested_by_name ?? '-'} | ${String(r.created_at).slice(0, 10)} | decided by ${r.decided_by ?? '-'} | ${String(r.finance_note ?? '').slice(0, 60)}`);

  const sales = appFor(tx, co, code, people.sales);
  const exec = appFor(tx, co, code, people.exec);
  const owner = appFor(tx, co, code, people.owner);
  /* The real ones waiting: what pressing Reject on each would do (rolled back with the rest). */
  const realOnes = await tx`SELECT id, request_no, refund_source_doc_no, amount_sen FROM scm.acc_payment_requests WHERE company_id = ${co} AND refund_source_doc_no IS NOT NULL AND status = 'SUBMITTED' ORDER BY created_at`;
  for (const r of realOnes) {
    const path = `/mfg-sales-orders/${encodeURIComponent(r.refund_source_doc_no)}/money`;
    const was = (await owner(path)).body.money;
    const said = await owner(`/payment-requests/${r.id}/return`, 'POST', { note: 'TRIAL: rolled back' });
    const now = (await owner(path)).body.money;
    check(said.status === 200 && now?.requestedSen === (was?.requestedSen ?? 0) - Number(r.amount_sen) && now?.remainingSen === (was?.remainingSen ?? 0) + Number(r.amount_sen), `Owner rejects the real ${r.request_no} (${rm(r.amount_sen)} on ${r.refund_source_doc_no}): ${said.status} ${said.body.error ?? ''} ${String(said.body.message ?? '').slice(0, 80)}; order requested ${rm(was?.requestedSen)} -> ${rm(now?.requestedSen)}, remaining ${rm(was?.remainingSen)} -> ${rm(now?.remainingSen)}`);
  }
  const sbList = pgrestShim(tx, 'scm');
  const list = await ordersWithMoney(sbList, co, { phone: null, cancelledOnly: false });
  if (!list.ok) { check(false, `orders with money: ${list.reason}`); return; }
  const order = list.rows.find((r) => r.remainingSen >= 20_000);
  if (!order) { out('no order with RM 200 of money left: skipped'); return; }
  const doc = order.docNo;
  out(`order ${doc}: remaining ${rm(order.remainingSen)}`);
  const moneyOf = async (who) => (await who(`/mfg-sales-orders/${encodeURIComponent(doc)}/money`)).body.money;
  const before = await moneyOf(sales);
  out(`before: paid ${rm(before.bookedSen)} requested ${rm(before.requestedSen)} remaining ${rm(before.remainingSen)}`);

  const raised = await sales(`/mfg-sales-orders/${encodeURIComponent(doc)}/money/refund`, 'POST', ask(10_000));
  check(raised.status === 201, `a salesperson (${people.sales.name}) raises a refund of RM 100.00: ${raised.status} ${raised.body.requestNo ?? JSON.stringify(raised.body).slice(0, 200)}`);
  if (raised.status !== 201) return;
  const id = raised.body.id;
  const waiting = await moneyOf(sales);
  check(waiting.requestedSen === before.requestedSen + 10_000 && waiting.remainingSen === before.remainingSen - 10_000, `while it waits it holds the money: requested ${rm(waiting.requestedSen)} remaining ${rm(waiting.remainingSen)}`);

  const inList = await exec('/payment-requests');
  const row = (inList.body.requests ?? []).find((r) => String(r.id) === String(id));
  check(inList.body.finance === true && row?.stage === 'SUBMITTED', `a Finance Executive (${people.exec.name}) sees it as Finance, stage ${row?.stage}`);

  const noWhy = await exec(`/payment-requests/${id}/return`, 'POST', { note: '  ' });
  check(noWhy.status === 400 && noWhy.body.error === 'note_required', `reject with no reason is refused: ${noWhy.status} ${noWhy.body.error}`);
  const salesTry = await sales(`/payment-requests/${id}/return`, 'POST', { note: 'not mine to reject' });
  check(salesTry.status === 403, `the salesperson cannot reject: ${salesTry.status}`);
  const rejected = await exec(`/payment-requests/${id}/return`, 'POST', { note: 'TRIAL: convert to a new order instead' });
  check(rejected.status === 200, `the Finance Executive rejects it: ${rejected.status} ${JSON.stringify(rejected.body).slice(0, 160)}`);

  const [stored] = await tx`SELECT status, finance_note, decided_by FROM scm.acc_payment_requests WHERE id = ${id}`;
  check(stored?.status === 'REJECTED' && stored?.decided_by === people.exec.name, `stored: ${stored?.status}, by ${stored?.decided_by}`);
  const after = await moneyOf(sales);
  check(after.requestedSen === before.requestedSen && after.remainingSen === before.remainingSen, `the money is back on the order: requested ${rm(after.requestedSen)} remaining ${rm(after.remainingSen)}`);
  const onPanel = (after.refundRequests ?? []).find((r) => String(r.id) === String(id));
  check(onPanel?.state === 'RETURNED' && onPanel?.financeNote === 'TRIAL: convert to a new order instead', `the order's panel says rejected, with the reason: ${onPanel?.state}`);
  const salesRead = await sales(`/payment-requests/${id}`);
  check(salesRead.status === 200 && salesRead.body.request?.stage === 'RETURNED', `the salesperson reads it: ${salesRead.status} stage ${salesRead.body.request?.stage}`);
  const again = await exec(`/payment-requests/${id}/return`, 'POST', { note: 'twice' });
  out(`rejecting it a second time: ${again.status} ${again.body.error ?? ''} ${String(again.body.message ?? '').slice(0, 90)}`);
  const edit = await sales(`/payment-requests/${id}`, 'PATCH', { purpose: 'changed' });
  out(`the salesperson editing it: ${edit.status} ${edit.body.error ?? ''}`);

  const second = await sales(`/mfg-sales-orders/${encodeURIComponent(doc)}/money/refund`, 'POST', ask(after.remainingSen));
  check(second.status === 201, `another refund for everything left (${rm(after.remainingSen)}) can be raised: ${second.status} ${second.body.requestNo ?? JSON.stringify(second.body).slice(0, 200)}`);
  if (second.status === 201) {
    const byOwner = await owner(`/payment-requests/${second.body.id}/return`, 'POST', { note: 'TRIAL: owner says no' });
    check(byOwner.status === 200, `the Owner rejects that one: ${byOwner.status}`);
    const end = await moneyOf(sales);
    check(end.remainingSen === before.remainingSen, `the money is back again: remaining ${rm(end.remainingSen)}`);
  }
}

try {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL search_path = public, scm`;
    const load = async (where) => {
      const [u] = await where;
      if (!u) return null;
      const list = perms(u);
      return { ...u, role_name: u.role_name, permissions: list, permissions_set: new Set(list) };
    };
    const people = {
      exec: await load(tx`SELECT u.*, r.name AS role_name, r.permissions FROM public.users u JOIN public.roles r ON r.id = u.role_id WHERE u.status = 'active' AND u.name = 'Siti Rafidah' LIMIT 1`),
      owner: await load(tx`SELECT u.*, r.name AS role_name, r.permissions FROM public.users u JOIN public.roles r ON r.id = u.role_id WHERE u.status = 'active' AND r.name = 'Owner' LIMIT 1`),
      sales: await load(tx`SELECT u.*, r.name AS role_name, r.permissions FROM public.users u JOIN public.roles r ON r.id = u.role_id WHERE u.status = 'active' AND r.name = 'Sales Person' ORDER BY u.id LIMIT 1`),
    };
    out(`as: exec ${people.exec?.name} (${people.exec?.role_name}), owner ${people.owner?.name} (${people.owner?.role_name}), sales ${people.sales?.name} (${people.sales?.role_name})`);
    const companies = await tx`SELECT id, code FROM public.companies ORDER BY id`;
    for (const co of companies) await trial(tx, Number(co.id), String(co.code), people);
    throw new Rollback('always');
  });
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
}
const [left] = await sql`SELECT count(*)::int AS n FROM scm.acc_payment_requests WHERE purpose = ${REASON}`;
check(left.n === 0, `a fresh read: ${left.n} trial requests left on the books`);
out(bad.length === 0 ? 'ALL OK' : `FAILED: ${bad.join(' | ')}`);
await sql.end();
