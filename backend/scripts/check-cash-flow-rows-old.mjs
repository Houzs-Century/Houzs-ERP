#!/usr/bin/env node
// check-cash-flow-rows.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// The Cash Flow through the app's real handler on production, per month and over the
// span, printed so one run on the old code and one on the new can be compared: the STABLE
// line must not move at all; only the SPLIT line may differ.
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const monthEnd = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const MONTHS = { 1: ['2026-09', '2026-10', '2026-11'], 2: ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'] };
const isCard = (key) => /:CARD-[A-Z]+$/.test(key);
const partOf = (key) => key.slice(key.lastIndexOf(':') + 1);
const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b)));

await sql.begin('READ ONLY', async (tx) => {
  const companies = await tx`SELECT id, code FROM public.companies ORDER BY id`;
  for (const co of companies) {
    const c = Number(co.id);
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.onError((e, ctx) => ctx.json({ error: 'thrown', message: String(e?.stack ?? e) }, 500));
    app.use('*', async (ctx, next) => {
      ctx.set('supabase', sb);
      ctx.set('companyId', c);
      ctx.set('allowedCompanyIds', [c]);
      ctx.set('houzsUser', { name: 'read-only check', permissions_set: ['scm.payment_voucher.post'] });
      await next();
    });
    app.get('/rp', receiptsPaymentsReport);
    const months = MONTHS[c] ?? [];
    const periods = [...months.map((m) => [`${m}-01`, monthEnd(m) > TODAY ? TODAY : monthEnd(m)]), [`${months[0]}-01`, TODAY]];
    for (const [from, to] of periods) {
      const res = await app.request(`/rp?from=${from}&to=${to}`);
      const body = await res.json();
      if (res.status !== 200) { out(`ERROR|${co.code}|${from}..${to}|${res.status}|${JSON.stringify(body).slice(0, 600)}`); continue; }
      const receipts = body.receipts ?? [];
      const payments = body.payments ?? [];
      const card = receipts.filter((r) => isCard(r.key));
      const cardTotal = card.reduce((s, r) => s + r.totalSen, 0);
      const cardByKind = {};
      for (const r of card) { const k = r.key.split(':').at(-2); cardByKind[k] = (cardByKind[k] ?? 0) + r.totalSen; }
      const others = [...receipts.filter((r) => !isCard(r.key)), ...payments].map((r) => [r.key, r.totalSen, sorted(r.cells)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const hash = createHash('sha1').update(JSON.stringify(others)).digest('hex').slice(0, 12);
      out(`STABLE|${co.code}|${from}..${to}|in ${rm(body.layout.inSen)}|out ${rm(body.layout.outSen)}|opening ${rm(body.totals.openingTotalSen)}|closing ${rm(body.totals.closingTotalSen)}|card c/f ${rm(body.totals.closing?.CARD)}|card swipes ${rm(cardTotal)} ${Object.entries(sorted(cardByKind)).map(([k, v]) => `${k} ${rm(v)}`).join(' ')}|other rows ${others.length} ${hash}`);
      const parts = {};
      for (const r of card) { const p = partOf(r.key); parts[p] = (parts[p] ?? 0) + r.totalSen; }
      out(`SPLIT|${co.code}|${from}..${to}|${Object.entries(sorted(parts)).map(([k, v]) => `${k} ${rm(v)}`).join(' | ')}`);
      if (from.endsWith('-01') && to === TODAY && from === `${months[0]}-01`) {
        const walk = (n, depth) => {
          if (n.label === 'Deposit' || n.label === 'Balance') {
            out(`TREE|${co.code}|${n.label} ${rm(n.amountSen)}: ${(n.children ?? []).map((x) => `${x.label} ${rm(x.amountSen)}`).join(' / ')}`);
            return;
          }
          for (const k of n.children ?? []) walk(k, depth + 1);
        };
        for (const n of body.layout.tree ?? []) walk(n, 0);
      }
    }
    const gaps = sb.__gaps ?? [];
    out(`shim gaps ${co.code}: ${JSON.stringify(gaps).slice(0, 300)}`);
  }
});
await sql.end();
