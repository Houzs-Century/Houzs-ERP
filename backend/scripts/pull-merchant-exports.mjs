#!/usr/bin/env node
// pull-merchant-exports.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06: 「我要看export出来的成效」. The rows of the two Merchant Recon tables,
// through the app's real handlers, so a sample file can be built from what the screen shows:
// "Merchant reports still to reconcile" (every open line of every open report) and
// "Card payments no merchant report has reported yet" (with the order's Ref No.).
// Each row is printed base64 so names survive the log; totals are read again by plain SQL.
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { settlementBatches, settlementBatchDetail, settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';
import { readSoRefs } from '../src/scm/lib/so-ref-lookup.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const emit = (kind, obj) => console.log(`B64|${kind}|${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')}`);
const CO = 1;

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const sb = pgrestShim(tx, 'scm');
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String(e?.stack ?? e).slice(0, 600) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase', sb);
    c.set('companyId', CO);
    c.set('user', { id: null });
    c.set('houzsUser', { id: 0, role_name: 'Finance', permissions: ['scm.payment_voucher.post'], permissions_set: new Set(['scm.payment_voucher.post']) });
    c.set('allowedCompanyIds', [CO]);
    c.set('companies', [{ id: CO, code: String(CO) }]);
    c.set('companyCode', String(CO));
    await next();
  });
  app.get('/watchlist', settlementWatchlist);
  app.get('/batches', settlementBatches);
  app.get('/batches/:id', settlementBatchDetail);
  const get = async (path) => {
    const res = await app.request(path);
    const body = await res.json();
    if (res.status !== 200) throw new Error(`${path} ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
    return body;
  };

  /* The second table. */
  const watch = await get('/watchlist');
  const rows = watch.recordedNotArrived;
  const refs = await readSoRefs(sb, rows.filter((p) => p.source === 'SOPAY').map((p) => p.docNo), (q) => q.eq('company_id', CO));
  if (refs.error) throw new Error(`refs: ${refs.error}`);
  for (const p of rows) {
    const o = p.source === 'SOPAY' ? refs.byDoc.get(p.docNo) : null;
    emit('W', {
      merchant: p.acquirerCode ?? null, docNo: p.docNo, source: p.source, sales: p.salespersonName ?? null,
      paidOn: p.paidOn, days: p.ageDays, amountSen: p.amountSen, sheet: p.accountSheet ?? null, approval: p.approvalCode ?? null,
      ref: o?.ref ?? null, customerSoNo: o?.customer_so_no ?? null,
    });
  }
  out(`watch list ${watch.from} to ${watch.to}: ${rows.length} rows, sen ${rows.reduce((s, p) => s + Number(p.amountSen), 0)}`);

  /* The first table: the order the screen lists them in, its own "open" test. */
  const { batches } = await get('/batches');
  const open = batches.filter((b) => (b.open_count ?? 0) > 0);
  out(`reports ${batches.length}, open ${open.length}, open_count total ${open.reduce((s, b) => s + b.open_count, 0)}`);
  const pick = (l) => ({
    docNo: l.doc_no ?? l.docNo ?? l.payment_id ?? l.id ?? null, customer: l.customer_name ?? l.customerName ?? null,
    sales: l.salesperson ?? null, sheet: l.account_sheet ?? l.accountSheet ?? null, paidOn: l.paid_on ?? l.paidOn ?? null,
    code: l.approval_code ?? l.approvalCode ?? null, amountSen: l.amount_sen ?? l.amountSen ?? null,
  });
  let lines = 0; let gross = 0; let net = 0; let fee = 0; let refreshed = 0;
  for (const b of open) {
    const d = await get(`/batches/${b.id}`);
    refreshed += (d.refreshedLinks ?? []).length;
    for (const r of d.rows.filter((x) => !x.confirmed_at && x.bucket !== 'IGNORED')) {
      lines += 1; gross += Number(r.gross_sen); net += Number(r.net_sen); fee += Number(r.fee_sen);
      emit('L', {
        batchId: b.id, merchant: b.acquirer_code, file: b.file_name, line: r.line_no, date: r.txn_date, ref: r.ref,
        gross: r.gross_sen, fee: r.fee_sen, net: r.net_sen, bucket: r.bucket, group: r.matched_with ? r.matched_with.lines.length : 0,
        linked: r.linked.map(pick), suggested: (r.suggested ?? []).map(pick), candidates: (r.candidates ?? []).length,
      });
    }
  }
  out(`lines emitted ${lines}, gross sen ${gross}, fee sen ${fee}, net sen ${net}, links that would refresh ${refreshed}`);
  const [t] = await tx`
    SELECT count(*)::int AS lines, count(DISTINCT batch_id)::int AS reports, COALESCE(sum(gross_sen), 0)::bigint AS gross, COALESCE(sum(fee_sen), 0)::bigint AS fee, COALESCE(sum(net_sen), 0)::bigint AS net
      FROM scm.acc_settlement_rows WHERE company_id = ${CO} AND confirmed_at IS NULL AND bucket::text <> 'IGNORED'`;
  out(`plain SQL: reports ${t.reports}, lines ${t.lines}, gross sen ${t.gross}, fee sen ${t.fee}, net sen ${t.net}`);
});
await sql.end();
