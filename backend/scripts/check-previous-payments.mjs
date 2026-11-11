#!/usr/bin/env node
// check-previous-payments.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11: 「我说的是sales man 的收款记录（包括imported from autocount)」 — the
// payment records a salesperson keyed (and the ones imported from AutoCount) that
// belong to the previous system: where do they show up today? Through the shipped
// handlers: Merchant Recon's "card payments not reported yet" (settlementWatchlist)
// and Payments not matched yet (unmatchedPaymentsHandler); and by the tables:
// which have an entry in the books, dated before or after the books start.
// Prints counts, dates and yes/no — no money, no names (public logs).
// Env: DATABASE_URL, COMPANY_IDS (default 1,2).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { settlementWatchlist } from '../src/scm/routes/accounting-settlement.ts';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const COS = String(process.env.COMPANY_IDS || '1,2').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const back = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '')).slice(0, 10);
const tally = (xs, key) => Object.entries(xs.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m; }, {})).sort().map(([k, n]) => `${k} ${n}`).join(', ') || '—';

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    for (const CO of COS) {
      const [open] = await tx`
        SELECT min(entry_date) AS day FROM scm.journal_entries
         WHERE company_id = ${CO} AND source_type = 'OPENING' AND posted = true`;
      const START = open?.day ? d10(open.day) : null;
      row('BOOKS_START', `co${CO}`, START ?? 'no opening journal');

      /* Every payment's method and day, and whether a live entry in the books carries it. */
      const pays = await tx`
        SELECT 'SOPAY' AS src, p.id::text AS id, p.method, to_char(p.paid_at, 'YYYY-MM-DD') AS paid,
               EXISTS (SELECT 1 FROM scm.journal_entries j WHERE j.company_id = p.company_id AND j.source_type = 'SOPAY'
                        AND j.source_doc_no = p.id::text AND j.posted AND NOT coalesce(j.reversed, false)) AS booked
          FROM scm.mfg_sales_order_payments p WHERE p.company_id = ${CO}
        UNION ALL
        SELECT 'SIPAY', p.id::text, p.method, to_char(p.paid_at, 'YYYY-MM-DD'),
               EXISTS (SELECT 1 FROM scm.journal_entries j WHERE j.company_id = p.company_id AND j.source_type = 'SIPAY'
                        AND j.source_doc_no = p.id::text AND j.posted AND NOT coalesce(j.reversed, false))
          FROM scm.sales_invoice_payments p WHERE p.company_id = ${CO}`;
      const byKey = new Map(pays.map((p) => [`${p.src}:${p.id}`, p]));
      const when = (p) => (START == null ? '?' : p.paid < START ? 'before books' : 'from books start');
      const imported = pays.filter((p) => p.method === 'imported');
      row('IMPORTED', `co${CO}`, `rows ${imported.length}`, `paid ${imported.map((p) => p.paid).sort()[0] ?? '—'}..${imported.map((p) => p.paid).sort().at(-1) ?? '—'}`,
        `with a live entry ${imported.filter((p) => p.booked).length}`, tally(imported, when));
      const keyed = pays.filter((p) => p.method !== 'imported' && p.method !== 'cash' && p.method !== 'converted');
      row('KEYED_BEFORE_BOOKS', `co${CO}`, `rows ${keyed.filter((p) => START && p.paid < START).length}`,
        `with a live entry ${keyed.filter((p) => START && p.paid < START && p.booked).length}`, tally(keyed.filter((p) => START && p.paid < START), (p) => p.method));

      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
        c.set('houzsUser', { name: 'read-only check', permissions_set: ['*', 'scm.payment_voucher.post'] });
        await next();
      });
      app.get('/w', settlementWatchlist);
      app.get('/p', unmatchedPaymentsHandler);

      /* Merchant Recon's "card payments not reported yet": the screen's own window (90 days), and all time. */
      for (const [label, q] of [['90 days', ''], ['all time', `?from=2024-01-01&to=${TODAY}`]]) {
        const res = await app.request(`/w${q}`);
        if (res.status !== 200) { row('WATCHLIST', `co${CO}`, label, `REFUSED ${res.status}`); continue; }
        const body = await res.json();
        const rows = body.recordedNotArrived ?? [];
        const facts = rows.map((r) => byKey.get(`${r.source ?? 'SOPAY'}:${r.id ?? r.paymentId}`)).filter(Boolean);
        row('WATCHLIST', `co${CO}`, label, `rows ${rows.length}`, `found ${facts.length}`,
          `imported ${facts.filter((p) => p.method === 'imported').length}`, tally(facts, when),
          `with a live entry ${facts.filter((p) => p.booked).length}`);
      }

      /* Payments not matched yet, its own 180 days. */
      const res = await app.request(`/p?from=${back(180)}&to=${TODAY}`);
      if (res.status !== 200) { row('UNMATCHED', `co${CO}`, `REFUSED ${res.status}`); continue; }
      const urows = (await res.json()).rows ?? [];
      const ufacts = urows.map((r) => byKey.get(`${r.source}:${r.paymentId}`)).filter(Boolean);
      row('UNMATCHED', `co${CO}`, `rows ${urows.length}`, tally(ufacts, when), `with a live entry ${ufacts.filter((p) => p.booked).length}`,
        `states ${tally(urows, (r) => r.state)}`);
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
