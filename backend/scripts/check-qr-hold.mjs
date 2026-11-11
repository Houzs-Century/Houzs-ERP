#!/usr/bin/env node
// check-qr-hold.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// Owner 2026-11-11, on a row of Payments not matched yet (an Online payment,
// "Not matched to the bank statement yet"): 「像这笔我印象是merchant match 了，
// 但是因为另外一笔 bank statement stuck 着 match 不到」. For one order's payments:
//   1. its row on Payments not matched yet (the shipped handler);
//   2. its live entry, and any bank line holding that entry (POSTED or not);
//   3. the merchant line linked to it, and every QR line of that line's report —
//      linked or open; for an open one, whether a sale of its amount is keyed now
//      (the shipped Find the sale);
//   4. the bank credit that report's money came in as, read through Bank Recon's
//      own statement screen (GET /bank/statements/:id), so "ready" and "waiting"
//      are exactly what Bank Recon shows.
// Prints ids, dates, states and yes/no. Names are never printed; the guard
// redacts any money — this repository's Actions logs are public.
// Env: DATABASE_URL, COMPANY_ID (default 2), DOC (the order number),
//      MERCHANT (default 5992284, the QR merchant number on the bank's text).
import './lib/public-log-guard.mjs';
import postgres from 'postgres';
import { Hono } from 'hono';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { findPaymentsForRow } from '../src/acc/settlement.ts';
import { bankStatementDetail } from '../src/scm/routes/accounting-bank.ts';
import { unmatchedPaymentsHandler } from '../src/scm/routes/accounting-unmatched-payments.ts';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('check-qr-hold.mjs is read-only: run it with mode=plan.'); process.exit(1); }
const CO = Number(process.env.COMPANY_ID || 2);
const DOC = String(process.env.DOC || '').trim();
const MERCHANT = String(process.env.MERCHANT || '5992284').replace(/[^0-9]/g, '');
if (!/^[A-Z0-9]+-SO-\d{4}-\d+$/.test(DOC)) { console.error('DOC must be an order number.'); process.exit(2); }

const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const d10 = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '—')).slice(0, 10);
const yn = (b) => (b ? 'yes' : 'no');
const row = (...parts) => console.log(`ROW|${parts.join('|')}`);
const head = (t) => console.log(`\n=== ${t}`);
const TODAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const jeNosOf = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

try {
  await sql.begin('read only', async (tx) => {
    const sb = pgrestShim(tx, 'scm');
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('supabase', sb); c.set('companyId', CO); c.set('allowedCompanyIds', [CO]);
      c.set('houzsUser', { name: 'read-only check', permissions_set: ['*', 'scm.payment_voucher.post'] });
      await next();
    });
    app.get('/p', unmatchedPaymentsHandler);
    app.get('/bank/statements/:id', bankStatementDetail);

    head(`Payments of ${DOC}, company ${CO}`);
    const pays = await tx`
      SELECT id, method, online_type, merchant_provider, paid_at, amount_sen
        FROM scm.mfg_sales_order_payments
       WHERE company_id = ${CO} AND so_doc_no = ${DOC}
       ORDER BY id`;
    if (pays.length === 0) row('PAYMENT', 'none');
    const myJe = new Map();
    const batches = new Map();
    for (const p of pays) {
      row('PAYMENT', `id ${p.id}`, `method ${p.method}`, `online type ${p.online_type ?? '—'}`, `merchant ${p.merchant_provider ?? '—'}`, `paid ${d10(p.paid_at)}`);

      const je = await sb.from('journal_entries').select('id, je_no, reversed, posted, entry_date')
        .eq('company_id', CO).eq('source_type', 'SOPAY').eq('source_doc_no', String(p.id)).order('je_no');
      if (je.error) { row('ENTRY', `REFUSED ${je.error.message}`); continue; }
      for (const e of je.data ?? []) {
        const lines = await sb.from('journal_entry_lines').select('account_code, debit_sen').eq('journal_entry_id', e.id);
        const debit = (lines.data ?? []).filter((l) => Number(l.debit_sen ?? 0) > 0).map((l) => l.account_code).join(', ');
        row('ENTRY', e.je_no, `posted ${yn(e.posted)}`, `reversed ${yn(e.reversed)}`, `dated ${d10(e.entry_date)}`, `debits ${debit || '—'}`);
        if (e.posted && !e.reversed) myJe.set(String(p.id), String(e.je_no));

        const held = await tx`
          SELECT m.bank_line_id, l.state, l.kind, l.booked_on, l.statement_id
            FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
           WHERE m.company_id = ${CO} AND m.je_no = ${String(e.je_no)}`;
        for (const h of held) row('BANK_MATCH_ROW', `line ${h.bank_line_id}`, `state ${h.state}`, `kind ${h.kind}`, `booked ${d10(h.booked_on)}`, `statement ${h.statement_id}`);
        const named = await tx`
          SELECT id, state, kind, booked_on, posted_je_no FROM scm.acc_bank_statement_lines
           WHERE company_id = ${CO} AND posted_je_no LIKE ${'%' + String(e.je_no) + '%'}`;
        for (const n of named.filter((x) => jeNosOf(x.posted_je_no).includes(String(e.je_no)))) {
          row('BANK_NAMES_IT', `line ${n.id}`, `state ${n.state}`, `kind ${n.kind}`, `booked ${d10(n.booked_on)}`);
        }
        if (held.length === 0 && named.length === 0) row('BANK', `${e.je_no}: no bank line holds it, posted or not`);
      }

      const links = await tx`
        SELECT m.settlement_row_id, m.payment_source, r.batch_id, r.line_no, r.channel, r.txn_date,
               r.confirmed_at, r.posted_je_no, r.bucket, (r.gross_sen = ${Number(p.amount_sen)}) AS same_amount,
               b.file_name, b.acquirer_code
          FROM scm.acc_settlement_matches m
          JOIN scm.acc_settlement_rows r ON r.id = m.settlement_row_id
          JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
         WHERE m.company_id = ${CO} AND m.payment_id = ${String(p.id)}`;
      if (links.length === 0) row('MERCHANT', `payment ${p.id}: no merchant line is linked to it`);
      for (const l of links) {
        row('MERCHANT', `payment ${p.id}`, `settlement line id ${l.settlement_row_id}`, `line no ${l.line_no}`, `channel ${l.channel ?? '—'}`,
          `txn ${d10(l.txn_date)}`, `confirmed ${yn(l.confirmed_at != null)}`, `posted entry ${yn(l.posted_je_no != null)}`,
          `bucket ${l.bucket ?? '—'}`, `same amount as the payment ${yn(l.same_amount)}`, `report ${l.batch_id} ${l.acquirer_code} ${l.file_name ?? ''}`);
        batches.set(Number(l.batch_id), Number(l.settlement_row_id));
      }
    }

    for (const [batchId] of batches) {
      head(`QR lines of report ${batchId}`);
      const qr = await tx`
        SELECT id, line_no, txn_date, confirmed_at, bucket, gross_sen FROM scm.acc_settlement_rows
         WHERE company_id = ${CO} AND batch_id = ${batchId} AND channel = 'QR' ORDER BY line_no, id`;
      const ids = qr.map((r) => Number(r.id));
      const qrLinks = ids.length === 0 ? [] : await tx`
        SELECT settlement_row_id, doc_no FROM scm.acc_settlement_matches
         WHERE company_id = ${CO} AND settlement_row_id IN ${tx(ids)} ORDER BY id`;
      for (const r of qr) {
        const mine = qrLinks.filter((l) => Number(l.settlement_row_id) === Number(r.id)).map((l) => l.doc_no ?? '?');
        row('QR_LINE', `id ${r.id}`, `line no ${r.line_no}`, `txn ${d10(r.txn_date)}`, `linked ${yn(r.confirmed_at != null)}`,
          `bucket ${r.bucket ?? '—'}`, `sale ${mine.join(' + ') || '—'}`, mine.includes(DOC) ? '<- this order' : '');
        if (r.confirmed_at == null) {
          const found = await findPaymentsForRow(sb, CO, Number(r.id), '', 500);
          if (!found.ok) { row('FIND', `id ${r.id}`, `REFUSED ${found.status}`); continue; }
          const hits = found.payments.filter((x) => Number(x.amountSen) === Number(r.gross_sen));
          row('FIND', `id ${r.id}`, `Find the sale offers ${found.payments.length}`, `same-amount sales ${hits.length}`,
            hits.map((x) => `${x.docNo} paid ${x.paidOn} ${x.method}`).join(' ; ') || '—');
        }
      }
      const days = qr.map((r) => d10(r.txn_date)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (days.length === 0) continue;

      head(`QR merchant credits (${MERCHANT}) booked ${days[0]}..${shift(days.at(-1), 10)}, as Bank Recon shows them`);
      const credits = await tx`
        SELECT id, statement_id FROM scm.acc_bank_statement_lines
         WHERE company_id = ${CO} AND amount_sen > 0
           AND booked_on BETWEEN ${days[0]} AND ${shift(days.at(-1), 10)}
           AND (description ILIKE ${'%' + MERCHANT + '%'} OR reference ILIKE ${'%' + MERCHANT + '%'})
         ORDER BY booked_on, id`;
      const want = new Set(credits.map((l) => Number(l.id)));
      for (const sid of [...new Set(credits.map((l) => Number(l.statement_id)))].sort((a, b) => a - b)) {
        const res = await app.request(`/bank/statements/${sid}`);
        const body = await res.json();
        if (res.status !== 200) { row('STMT', sid, `REFUSED ${res.status}`); continue; }
        const s = body.statement;
        row('STMT', sid, s.account_code, `${d10(s.period_from)}..${d10(s.period_to)}`);
        for (const l of body.lines.filter((x) => want.has(Number(x.id)))) {
          const q = l.qr_sales;
          const holds = [...jeNosOf(l.posted_je_no), ...(l.matches ?? []).map((m) => m.je_no)];
          const ours = [...myJe.values()];
          row('BANK_CREDIT', `line ${l.id}`, `booked ${d10(l.booked_on)}`, `state ${l.state}`, `kind ${l.kind}`,
            l.state === 'POSTED' ? `holds this order's entry ${yn(holds.some((j) => ours.includes(j)))}` : '',
            q
              ? `QR report ${q.batchId}${q.batchId === batchId ? ' (this one)' : ''} · trading ${q.tradingDate ?? '—'} · ready ${yn(q.ready)}`
                + ` · sales ${q.sales.map((x) => `${x.docNo ?? '?'}${x.jeNo && ours.includes(x.jeNo) ? ' <- this order' : ''}`).join(' + ') || '—'}`
                + ` · waiting QR line no ${q.waiting.map((w) => `${w.lineNo} (txn ${w.txnDate})`).join(', ') || '—'}`
                + ` · says: ${q.clue}`
              : `note: ${String(l.note ?? '').slice(0, 220)}`);
        }
      }
    }

    head(`${DOC} on Payments not matched yet`);
    const firstPaid = pays.map((p) => d10(p.paid_at)).sort()[0] ?? TODAY;
    const res = await app.request(`/p?from=${shift(firstPaid, -1)}&to=${TODAY}`);
    if (res.status !== 200) { row('LIST', `REFUSED ${res.status}`); }
    else {
      const rows = ((await res.json()).rows ?? []).filter((r) => r.docNo === DOC);
      if (rows.length === 0) row('LIST', 'not listed');
      for (const r of rows) {
        row('LIST', `payment ${r.paymentId}`, `kind ${r.kind}`, `channel ${r.channel ?? '—'}`, `state ${r.state}`,
          `entry ${r.jeNo ?? '—'}`, `account ${r.bankAccountCode ?? '—'}`, `statements reach ${r.statementUpTo ?? '—'}`);
      }
    }
  });
  console.log('\nRead-only: nothing was written.');
} finally {
  await sql.end();
}
