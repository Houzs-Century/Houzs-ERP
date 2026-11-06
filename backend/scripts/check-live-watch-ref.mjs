#!/usr/bin/env node
// check-live-watch-ref.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// After #5349: the watch list through the handler as merged, on production's real columns (a fake
// client never catches a wrong column). Does every row come back with its order's Ref No.?
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
/* The screen's one rule (frontend/src/lib/customer-ref.ts). */
const refNo = (p) => String(p.ref || p.customer_so_no || '').trim();

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  for (const co of [1, 2]) {
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
    const res = await app.request('/watchlist');
    const body = await res.json();
    if (res.status !== 200) throw new Error(`watchlist ${res.status}: ${JSON.stringify(body).slice(0, 400)}`);
    const rows = body.recordedNotArrived;
    const shown = rows.filter((p) => refNo(p));
    out(`co ${co}: ${rows.length} rows, RM ${rm(rows.reduce((s, p) => s + Number(p.amountSen), 0))}; Ref No. shows on ${shown.length}; the pair arrives on ${rows.filter((p) => 'ref' in p && 'customer_so_no' in p).length}`);
    for (const p of shown.slice(0, 3)) out(`   ${p.docNo} -> ${refNo(p)} | sheet ${p.accountSheet ?? '-'} | approval ${p.approvalCode ?? '-'}`);
  }
});
await sql.end();
