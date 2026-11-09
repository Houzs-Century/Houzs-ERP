#!/usr/bin/env node
// check-qr-status.mjs — READ-ONLY. Where a company's DuitNow QR money stands
// today (owner 2026-11-09 「所以都好了？」):
//  1. every QR line on Merchant Recon — linked to which sale, or still open;
//  2. for an open one, whether a sale of its amount has been keyed since — the
//     shipped Find the sale (acc/settlement findPaymentsForRow), run as-is;
//  3. every QR merchant credit on the bank statements (and any LINE_IDS), read
//     through the app's own statement screen (GET /bank/statements/:id), so
//     "ready" is exactly what Bank Recon shows.
//
// One READ ONLY transaction; MODE=apply refused.
// Env: DATABASE_URL, COMPANY_ID (default 2), MERCHANT (default 5992284),
//      LINE_IDS (optional, comma list of bank line ids to show as well).
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { findPaymentsForRow } from '../src/acc/settlement.ts';
import { bankStatementDetail } from '../src/scm/routes/accounting-bank.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-qr-status.mjs is read-only: run it with mode=plan.'); process.exit(1); }

const CO = Number(process.env.COMPANY_ID || 2);
const MERCHANT = String(process.env.MERCHANT || '5992284').replace(/[^0-9]/g, '');
const EXTRA = String(process.env.LINE_IDS || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '—')).slice(0, 10);
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');

    head(`QR lines on Merchant Recon, company ${CO}`);
    const rows = await tx`
      SELECT r.id, r.batch_id, r.line_no, r.txn_date, r.gross_sen, r.bucket, r.confirmed_at, r.notes, b.file_name
        FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
       WHERE r.company_id = ${CO} AND r.channel = 'QR'
       ORDER BY r.txn_date, r.id`;
    const ids = rows.map((r) => Number(r.id));
    const links = ids.length === 0 ? [] : await tx`
      SELECT m.settlement_row_id, m.doc_no, m.amount_sen, o.debtor_name
        FROM scm.acc_settlement_matches m
        LEFT JOIN scm.mfg_sales_orders o ON o.company_id = m.company_id AND o.doc_no = m.doc_no
       WHERE m.company_id = ${CO} AND m.settlement_row_id IN ${tx(ids)}
       ORDER BY m.id`;
    for (const r of rows) {
      const mine = links.filter((l) => Number(l.settlement_row_id) === Number(r.id));
      row('QR', `line ${r.id}`, d10(r.txn_date), `RM ${rm(r.gross_sen)}`, r.confirmed_at ? 'LINKED' : 'OPEN', r.bucket ?? '—',
        mine.length ? mine.map((l) => `${l.doc_no ?? '?'} ${l.debtor_name ?? '—'} RM ${rm(l.amount_sen)}`).join(' + ') : '—',
        `batch ${r.batch_id} ${r.file_name ?? ''}`, String(r.notes ?? '').slice(0, 160));
    }

    head('Open QR lines: is a sale of the same amount keyed now? (the shipped Find the sale)');
    for (const r of rows.filter((x) => !x.confirmed_at)) {
      const out = await findPaymentsForRow(sb, CO, Number(r.id), '', 500);
      if (!out.ok) { row('FIND', `line ${r.id}`, `REFUSED ${out.status} ${out.reason}`); continue; }
      const same = out.payments.filter((p) => Number(p.amountSen) === Number(r.gross_sen));
      row('FIND', `line ${r.id}`, d10(r.txn_date), `RM ${rm(r.gross_sen)}`, `offered ${out.payments.length}`, `same amount ${same.length}`,
        same.map((p) => `${p.docNo} ${p.paidOn} ${p.method} ${p.customerName ?? '—'}`).join(' ; ') || '—');
    }

    head(`QR merchant credits (${MERCHANT}) on company ${CO}'s bank statements, as Bank Recon shows them`);
    const credits = await tx`
      SELECT l.id, l.statement_id FROM scm.acc_bank_statement_lines l
       WHERE l.company_id = ${CO} AND l.amount_sen > 0
         AND (l.description ILIKE ${'%' + MERCHANT + '%'} OR l.reference ILIKE ${'%' + MERCHANT + '%'})
       ORDER BY l.booked_on, l.id`;
    const extra = EXTRA.length === 0 ? [] : await tx`
      SELECT id, statement_id FROM scm.acc_bank_statement_lines WHERE company_id = ${CO} AND id IN ${tx(EXTRA)}`;
    const want = new Set([...credits, ...extra].map((l) => Number(l.id)));
    const stmts = [...new Set([...credits, ...extra].map((l) => Number(l.statement_id)))].sort((a, b) => a - b);

    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb);
      c.set('companyId', CO);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['scm.payment_voucher.post'] });
      c.set('allowedCompanyIds', [CO]);
      await next();
    });
    app.get('/bank/statements/:id', bankStatementDetail);
    for (const sid of stmts) {
      const res = await app.request(`/bank/statements/${sid}`);
      const body = await res.json();
      if (res.status !== 200) { row('STMT', sid, `REFUSED ${res.status} ${JSON.stringify(body).slice(0, 300)}`); continue; }
      const s = body.statement;
      row('STMT', sid, s.account_code, `${d10(s.period_from)}..${d10(s.period_to)}`, s.file_name ?? '');
      for (const l of body.lines.filter((x) => want.has(Number(x.id)))) {
        const q = l.qr_sales;
        const holds = [l.posted_je_no, ...(l.matches ?? []).map((m) => m.je_no)].filter(Boolean).join(', ');
        row('BANK', `line ${l.id}`, d10(l.booked_on), `RM ${rm(l.amount_sen)}`, l.state, `kind ${l.kind}`,
          `${String(l.description ?? '').slice(0, 70)} / ${String(l.reference ?? '').slice(0, 40)}`,
          l.state === 'POSTED' ? `holds ${holds || '—'}` : '',
          q
            ? `QR ${q.ready ? 'READY' : 'not ready'} · report ${q.batchId} ${q.tradingDate ?? ''} · sales ${q.sales.map((x) => `${x.docNo} RM ${rm(x.amountSen)} ${x.jeNo ?? 'no entry'}`).join(' + ') || '—'} · waiting ${q.waiting.map((w) => `${w.txnDate} RM ${rm(w.grossSen)}`).join(' + ') || '—'} · ${q.clue}`
            : `note ${String(l.note ?? '').slice(0, 200)}`);
      }
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
