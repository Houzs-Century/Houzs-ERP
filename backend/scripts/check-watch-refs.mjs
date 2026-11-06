#!/usr/bin/env node
// check-watch-refs.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06 (先确定): on "Card payments no merchant report has reported yet" he wants
// the reference, HC, ZNT and so on. The list is read through the app's real handler, then:
// which field holds that reference on those very rows, how many have one, and how much
// the list leaves out by reading only 90 days back. Also the size of the other table.
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clean = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };
/* A booklet number: letters then digits, the shape the sales reports use (HC13025, ZNT6656). */
const BOOKLET = /\b(?:HC|PG|ZNT|ZNF|EGT|ZNA)\s?-?\s?\d{2,}/i;
const prefixOf = (v) => { const m = /^[A-Za-z]+/.exec(v.trim()); return m ? m[0].toUpperCase() : /^\d/.test(v.trim()) ? '(digits)' : '(other)'; };
const tally = (list, keyOf) => { const m = new Map(); for (const x of list) { const k = keyOf(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const show = (pairs, n = 14) => pairs.slice(0, n).map(([k, c]) => `${k} ${c}`).join(' · ');

const watch = async (tx, co, qs = '') => {
  const sb = pgrestShim(tx, 'scm');
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e).slice(0, 500) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase', sb);
    c.set('companyId', co);
    c.set('user', { id: null });
    c.set('houzsUser', { id: 0, role_name: 'Finance', permissions: ['scm.payment_voucher.post'], permissions_set: new Set(['scm.payment_voucher.post']) });
    c.set('allowedCompanyIds', [co]);
    c.set('companies', [{ id: co, code: String(co) }]);
    c.set('companyCode', String(co));
    await next();
  });
  app.get('/watchlist', settlementWatchlist);
  const res = await app.request(`/watchlist${qs}`);
  const body = await res.json();
  if (res.status !== 200) throw new Error(`watchlist ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
};

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const cols = await tx`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name IN ('mfg_sales_orders', 'mfg_sales_order_payments', 'sales_invoices', 'sales_invoice_payments')
       AND (column_name ILIKE '%ref%' OR column_name ILIKE '%customer_so%' OR column_name ILIKE '%booklet%' OR column_name ILIKE '%so_no%' OR column_name = 'note' OR column_name = 'account_sheet')
     ORDER BY table_name, column_name`;
  out(`ref-like columns: ${cols.map((c) => `${c.table_name}.${c.column_name}`).join(', ')}`);
  const cos = await tx`SELECT company_id, left(doc_no, 4) AS head, count(*)::int AS n FROM scm.mfg_sales_orders GROUP BY 1, 2 ORDER BY 1, 3 DESC`;
  out(`orders by company: ${cos.map((c) => `co ${c.company_id} ${c.head} ${c.n}`).join(' · ')}`);

  for (const co of [...new Set(cos.map((c) => c.company_id))]) {
    const list = await watch(tx, co);
    const rows = list.recordedNotArrived;
    out('');
    out(`=== co ${co}: watch list ${list.from} to ${list.to}: ${rows.length} rows, RM ${rm(rows.reduce((s, p) => s + Number(p.amountSen), 0))}; no bank tag ${rows.filter((p) => p.acquirerCode == null).length}`);
    if (rows.length === 0) continue;
    out(`source: ${show(tally(rows, (p) => p.source))}`);
    const docs = [...new Set(rows.filter((p) => p.source === 'SOPAY').map((p) => p.docNo).filter(Boolean))];
    const so = docs.length ? await tx`SELECT doc_no, ref, customer_so_no FROM scm.mfg_sales_orders WHERE company_id = ${co} AND doc_no IN ${tx(docs)}` : [];
    const byDoc = new Map(so.map((o) => [o.doc_no, o]));
    const with_ = rows.map((p) => {
      const o = p.source === 'SOPAY' ? byDoc.get(p.docNo) : null;
      const customer = clean(o?.customer_so_no);
      const ref = clean(o?.ref);
      /* The one display rule: customerRefOf = ref || customer_so_no. */
      return { p, customer, ref, shown: ref ?? customer };
    });
    out(`order's customer_so_no filled ${with_.filter((x) => x.customer).length}; ref filled ${with_.filter((x) => x.ref).length}; either ${with_.filter((x) => x.shown).length}; neither ${with_.filter((x) => !x.shown).length}`);
    out(`both filled and different: ${with_.filter((x) => x.customer && x.ref && x.customer !== x.ref).length}`);
    out(`Ref No. shape: booklet ${with_.filter((x) => x.shown && BOOKLET.test(x.shown)).length}; other words ${with_.filter((x) => x.shown && !BOOKLET.test(x.shown)).length}`);
    out(`Ref No. starts with: ${show(tally(with_.filter((x) => x.shown), (x) => prefixOf(x.shown)))}`);
    out(`samples with Ref No.:`);
    for (const x of with_.filter((y) => y.shown).slice(0, 8)) out(`   ${x.p.docNo} ${x.p.paidOn} ${rm(x.p.amountSen)} -> Ref No. ${x.shown} | approval ${x.p.approvalCode ?? '-'} | sheet ${x.p.accountSheet ?? '-'}`);
    out(`samples that are not booklet numbers:`);
    for (const x of with_.filter((y) => y.shown && !BOOKLET.test(y.shown)).slice(0, 8)) out(`   ${x.p.docNo} -> ${String(x.shown).slice(0, 40)}`);
    const none = with_.filter((x) => !x.shown);
    out(`no Ref No. by document head: ${show(tally(none, (x) => String(x.p.docNo).slice(0, 7)))}`);
    out(`no Ref No. by month paid: ${show(tally(none, (x) => String(x.p.paidOn).slice(0, 7)))}`);
    for (const x of none.slice(0, 6)) out(`   none: ${x.p.docNo} ${x.p.paidOn} ${rm(x.p.amountSen)} approval ${x.p.approvalCode ?? '-'} | sheet ${x.p.accountSheet ?? '-'}`);
    const apprBooklet = with_.filter((x) => BOOKLET.test(clean(x.p.approvalCode) ?? ''));
    const sheetBooklet = with_.filter((x) => BOOKLET.test(clean(x.p.accountSheet) ?? ''));
    out(`approval code holds a booklet number: ${apprBooklet.length}; of which the order has no Ref No.: ${apprBooklet.filter((x) => !x.shown).length}`);
    for (const x of apprBooklet.slice(0, 6)) out(`   ${x.p.docNo} approval ${x.p.approvalCode} | sheet ${x.p.accountSheet ?? '-'} | Ref No. ${x.shown ?? '-'}`);
    out(`account sheet holds a booklet number: ${sheetBooklet.length}; of which the order has no Ref No.: ${sheetBooklet.filter((x) => !x.shown).length}`);
    for (const x of sheetBooklet.slice(0, 6)) out(`   ${x.p.docNo} sheet ${x.p.accountSheet} | approval ${x.p.approvalCode ?? '-'} | Ref No. ${x.shown ?? '-'}`);
    out(`account sheet values: ${show(tally(with_, (x) => clean(x.p.accountSheet) ?? '(empty)'), 12)}`);
    out(`approval shape: ${show(tally(with_, (x) => { const v = clean(x.p.approvalCode); return !v ? '(empty)' : /^\d+$/.test(v) ? `digits ${v.length}` : BOOKLET.test(v) ? 'booklet' : 'other'; }), 10)}`);

    /* How much the list's 90-day window leaves out. */
    const everything = await watch(tx, co, '?from=2020-01-01');
    const older = everything.recordedNotArrived.filter((p) => p.paidOn < list.from);
    out(`from the very start: ${everything.recordedNotArrived.length} rows, RM ${rm(everything.recordedNotArrived.reduce((s, p) => s + Number(p.amountSen), 0))}; older than the list's ${list.from}: ${older.length} rows, RM ${rm(older.reduce((s, p) => s + Number(p.amountSen), 0))}`);
    out(`older by month paid: ${show(tally(older, (p) => String(p.paidOn).slice(0, 7)).sort((a, b) => (a[0] < b[0] ? -1 : 1)), 24)}`);

    /* The other table: what an export of "still to reconcile" would hold. */
    const [t] = await tx`
      SELECT count(*)::int AS lines, count(DISTINCT r.batch_id)::int AS reports, COALESCE(sum(r.gross_sen), 0)::bigint AS gross, COALESCE(sum(r.net_sen), 0)::bigint AS net
        FROM scm.acc_settlement_rows r
       WHERE r.company_id = ${co} AND r.confirmed_at IS NULL AND r.bucket::text <> 'IGNORED'`;
    out(`still to reconcile: ${t.reports} reports, ${t.lines} lines, gross RM ${rm(t.gross)}, net RM ${rm(t.net)}`);
  }
});
await sql.end();
