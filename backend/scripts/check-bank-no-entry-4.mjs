#!/usr/bin/env node
// check-bank-no-entry-4.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Bank recon "No entry found"): did Houzs's bank send the RM 1,682 of
// HC-HPV-2610-113 (refund to 2990, customer paid Houzs by mistake), and did Houzs's bank
// receive a 1,682 in October? Houzs (company 1) bank lines of ±1,682 from 01/10, with
// what each is matched to, and the entry HC-HPV-2610-113 posted.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);

await sql.begin('READ ONLY', async (tx) => {
  out('── Houzs bank lines of ±1,682 from 01/10');
  for (const l of await tx`
    SELECT s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.amount_sen, l.description, l.reference, to_jsonb(l)->>'state' AS state,
           (SELECT string_agg(m.je_no, ', ') FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS matched
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = 1 AND abs(l.amount_sen) = 168200 AND l.booked_on >= '2026-10-01' ORDER BY l.booked_on`) {
    out(`${l.account_code} st${l.statement_id} #${l.line_no} ${l.d} ${l.amount_sen} [${l.state}] ${l.description} | ref=${l.reference ?? '∅'} | ${l.matched ?? 'not matched'}`);
  }
  out('── the entry of HC-HPV-2610-113, and which bank lines hold it');
  for (const g of await tx`SELECT je_no, entry_date::text AS d, account_code, debit_sen - credit_sen AS net FROM scm.v_gl_entries WHERE company_id = 1 AND source_doc_no = 'HC-HPV-2610-113' ORDER BY account_code`) {
    out(`${g.je_no} ${g.d} ${g.account_code} ${g.net}`);
    for (const m of await tx`SELECT l.line_no, l.booked_on::text AS d, to_jsonb(l)->>'state' AS state FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id WHERE m.company_id = 1 AND m.je_no = ${g.je_no}`) {
      out(`   held by line #${m.line_no} ${m.d} [${m.state}]`);
    }
  }
});
await sql.end();
