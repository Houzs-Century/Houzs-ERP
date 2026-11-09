#!/usr/bin/env node
// check-bank-no-entry-3.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Bank recon "No entry found"), third look: which bank lines hold the
// transfer entries 2990-JE-2611-0077 (+40,000 Maybank → HLB) and -0073 (−33,000 HLB →
// Alliance), the 1,682 entry and the PV entry; 2990's SO payments of 2,120 / 3,500 from
// 01/10 and where they went; Houzs's HC-HPV-2610-113 (1,682 to 2990 HOME); and 2990's
// Maybank lines of 04–05/11.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const JES = ['2990-JE-2611-0077', '2990-JE-2611-0073', '2990-JE-2610-0263', '2990-JE-2610-0473'];

await sql.begin('READ ONLY', async (tx) => {
  out('── which bank lines hold these entries');
  for (const m of await tx`
    SELECT m.je_no, m.amount_sen, m.match_reason, s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.amount_sen AS line_sen, to_jsonb(l)->>'state' AS state, l.reference
      FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE m.company_id = 2 AND m.je_no = ANY(${JES}) ORDER BY m.je_no`) {
    out(`${m.je_no} ${m.amount_sen} (${m.match_reason ?? '∅'}) ← ${m.account_code} st${m.statement_id} #${m.line_no} ${m.d} ${m.line_sen} [${m.state}] ref=${m.reference ?? '∅'}`);
  }
  out('── the ledger legs of those entries');
  for (const g of await tx`SELECT je_no, entry_date::text AS d, account_code, debit_sen - credit_sen AS net, posted, reversed FROM scm.v_gl_entries WHERE company_id = 2 AND je_no = ANY(${JES}) ORDER BY je_no, account_code`) {
    out(`${g.je_no} ${g.d} ${g.account_code} ${g.net} posted=${g.posted} reversed=${g.reversed}`);
  }
  out('── 2990 SO payments of 2,120 / 3,500 from 01/10, and the money account each went to');
  for (const p of await tx`
    SELECT p.so_doc_no, o.debtor_name, p.amount_sen, p.paid_at::text AS paid, p.method,
           (SELECT string_agg(g.je_no || ' ' || g.entry_date::text || ' ' || g.account_code, '; ') FROM scm.v_gl_entries g WHERE g.company_id = 2 AND g.source_doc_no = p.id::text AND g.account_code LIKE '31%') AS gl
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
     WHERE p.company_id = 2 AND p.amount_sen IN (212000, 350000) AND p.paid_at >= '2026-10-01' ORDER BY p.paid_at`) {
    out(`${p.so_doc_no} ${p.debtor_name ?? '∅'} ${p.amount_sen} on ${p.paid} ${p.method ?? ''} | ${p.gl ?? 'no money-account line'}`);
  }
  out('── Houzs HC-HPV-2610-113');
  for (const r of await tx`SELECT to_jsonb(v) AS j FROM scm.payment_vouchers v WHERE v.pv_number = 'HC-HPV-2610-113'`) {
    const j = r.j;
    out(`${j.pv_number} payee=${j.payee_name} status=${j.status} voucher_date=${j.voucher_date} total=${j.total_sen} credit=${j.credit_account_code} notes=${String(j.notes ?? '').slice(0, 120).replace(/\n/g, ' / ')}`);
  }
  out('── 2990 Maybank and Alliance lines 03–06/11');
  for (const l of await tx`
    SELECT s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.amount_sen, l.charge_sen, l.reference, l.description, to_jsonb(l)->>'state' AS state,
           (SELECT string_agg(m.je_no, ', ') FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS matched
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = 2 AND s.account_code IN ('310-0010', '310-0030') AND l.booked_on BETWEEN '2026-11-03' AND '2026-11-06'
     ORDER BY s.account_code, l.booked_on, l.line_no`) {
    out(`${l.account_code} st${l.statement_id} #${l.line_no} ${l.d} ${l.amount_sen}${Number(l.charge_sen) ? ` charge ${l.charge_sen}` : ''} [${l.state}] ${l.description} | ref=${l.reference ?? '∅'} | ${l.matched ?? 'not matched'}`);
  }
  out('── 2990 bank lines of +1,682 anywhere from 01/10');
  for (const l of await tx`
    SELECT s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.reference, to_jsonb(l)->>'state' AS state
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = 2 AND l.amount_sen = 168200 AND l.booked_on >= '2026-10-01' ORDER BY l.booked_on`) {
    out(`${l.account_code} st${l.statement_id} #${l.line_no} ${l.d} [${l.state}] ref=${l.reference ?? '∅'}`);
  }
});
await sql.end();
