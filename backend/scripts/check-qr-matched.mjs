#!/usr/bin/env node
// check-qr-matched.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11 (QR 的单 merchant 对上了，也像卡一样不出现在 Payments → 做): read
// Payments not matched yet through the shipped handler on production data —
// how many payments, by stage; how many Online payments a CONFIRMED merchant
// line holds (QR sales), and whether any of them is still listed; and, for the
// orders in DOCS, whether each is listed.
// Prints counts, ids and yes/no — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_IDS (default 1,2), DAYS (default 180), DOCS (optional, comma list).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const DOCS = String(process.env.DOCS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TO = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const FROM = new Date(Date.parse(`${TO}T00:00:00Z`) - Number(process.env.DAYS || 180) * 86_400_000).toISOString().slice(0, 10);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*'] });
        await next();
      });
      app.get('/p', unmatchedPaymentsHandler);
      const res = await app.request(`/p?from=${FROM}&to=${TO}`);
      if (res.status !== 200) { row('REFUSED', `co${CO}`, res.status); continue; }
      const rows = (await res.json()).rows ?? [];
      const byState = {};
      for (const r of rows) byState[r.state] = (byState[r.state] ?? 0) + 1;
      row('PAYMENTS', `co${CO}`, `${FROM}..${TO}`, `rows ${rows.length}`,
        Object.entries(byState).sort().map(([k, n]) => `${k} ${n}`).join(', '));

      /* Online payments in the window that a CONFIRMED merchant line holds — the QR sales the rule leaves off. */
      const held = await tx`
        SELECT 'SOPAY' AS source, p.id::text AS id, p.so_doc_no AS doc, r.channel
          FROM scm.mfg_sales_order_payments p
          JOIN scm.acc_settlement_matches m ON m.company_id = p.company_id AND m.payment_source = 'SOPAY' AND m.payment_id = p.id::text
          JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
         WHERE p.company_id = ${CO} AND p.method = 'transfer' AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO + 'T23:59:59.999'}
           AND (r.confirmed_at IS NOT NULL OR r.posted_je_no IS NOT NULL)
        UNION ALL
        SELECT 'SIPAY', p.id::text, NULL, r.channel
          FROM scm.sales_invoice_payments p
          JOIN scm.acc_settlement_matches m ON m.company_id = p.company_id AND m.payment_source = 'SIPAY' AND m.payment_id = p.id::text
          JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
         WHERE p.company_id = ${CO} AND p.method = 'transfer' AND p.paid_at >= ${FROM} AND p.paid_at <= ${TO + 'T23:59:59.999'}
           AND (r.confirmed_at IS NOT NULL OR r.posted_je_no IS NOT NULL)`;
      const listed = new Set(rows.map((r) => `${r.source}:${r.paymentId}`));
      const still = held.filter((h) => listed.has(`${h.source}:${h.id}`));
      const channels = {};
      for (const h of held) channels[h.channel ?? 'card line'] = (channels[h.channel ?? 'card line'] ?? 0) + 1;
      row('QR_HELD', `co${CO}`, `online payments a confirmed merchant line holds ${held.length}`,
        Object.entries(channels).map(([k, n]) => `${k} ${n}`).join(', ') || '—',
        `still listed ${still.length}`, held.map((h) => h.doc ?? h.source).join(' ; ') || '—');

      for (const doc of DOCS) {
        const mine = rows.filter((r) => r.docNo === doc);
        row('DOC', `co${CO}`, doc, mine.length === 0 ? 'not listed' : mine.map((r) => `${r.kind} ${r.state}`).join(' ; '));
      }
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
