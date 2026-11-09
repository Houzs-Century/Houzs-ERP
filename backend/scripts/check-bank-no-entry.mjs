#!/usr/bin/env node
// check-bank-no-entry.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Bank recon, "No entry found", 然后像这种我该如何match?): the November
// bank lines on his screen — GAN LE SIANG SO2608040 SO2608053 5,990 in; 2990 HOME SDN BHD
// Transfer 7,000 in shown as "40,000 less 33,000 charge"; TAN ENG SIANG 2990 1,682 in;
// HOUZS CENTURY ... 2990-HPV-2610-026 11,845.60 out; HOUZS VENTURE ... 2990-HPV-2611-011
// 9.00 out; VERO MEDICAL SUPPLY 3,500 in — and what the books hold for each: the line as
// stored (charge, kind, state), its statement's neighbours that day, the PVs by number,
// the SO payments, and ledger lines of the same amounts on any money account near the day.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const pick = (j, keys) => keys.filter((k) => k in j).map((k) => `${k}=${j[k] === null ? '∅' : typeof j[k] === 'object' ? JSON.stringify(j[k]) : j[k]}`).join(' ');

const WORDS = ['GAN LE SIANG', '2990 HOME', 'TAN ENG SIANG', 'HOUZS CENTURY', 'HOUZS VENTURE', 'VERO MEDICAL'];
const PVS = ['2990-HPV-2610-026', '2990-HPV-2611-011'];
const AMOUNTS = [599000, 4000000, 3300000, 700000, 168200, 1184560, 900, 350000];

await sql.begin('READ ONLY', async (tx) => {
  for (const c of await tx`SELECT id, code FROM public.companies ORDER BY id`) out(`company ${c.id} ${c.code}`);

  out('── the bank lines on the screen (November)');
  const lines = await tx`
    SELECT to_jsonb(l) AS j, s.account_code, s.file_name
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.booked_on BETWEEN '2026-11-01' AND '2026-11-30'
       AND (${sql.unsafe(WORDS.map((w) => `upper(l.description) LIKE '%${w}%'`).join(' OR '))})
     ORDER BY l.booked_on, l.line_no`;
  const statements = new Set();
  for (const r of lines) {
    statements.add(`${r.j.statement_id}|${r.j.booked_on}`);
    out(`${r.account_code} ${r.file_name} :: ${pick(r.j, ['id', 'company_id', 'statement_id', 'line_no', 'booked_on', 'description', 'reference', 'amount_sen', 'charge_sen', 'kind', 'state', 'note', 'ignored_note', 'posted_je_no'])}`);
  }

  out('── every line of those statements on those days (what sits beside them)');
  for (const key of statements) {
    const [sid, day] = key.split('|');
    out(`statement ${sid} on ${String(day).slice(0, 10)}:`);
    for (const r of await tx`SELECT to_jsonb(l) AS j FROM scm.acc_bank_statement_lines l WHERE l.statement_id = ${sid} AND l.booked_on = ${String(day).slice(0, 10)} ORDER BY l.line_no`) {
      out(`   ${pick(r.j, ['line_no', 'description', 'reference', 'amount_sen', 'charge_sen', 'kind', 'state'])}`);
    }
  }

  out('── the payment vouchers named on the lines');
  for (const r of await tx`SELECT to_jsonb(v) AS j FROM scm.payment_vouchers v WHERE v.pv_number = ANY(${PVS})`) {
    const j = { ...r.j };
    for (const k of Object.keys(j)) if (typeof j[k] === 'string' && j[k].length > 80) j[k] = `${j[k].slice(0, 80)}…`;
    out(`PV ${JSON.stringify(j)}`);
  }
  out('── ledger lines carrying those PV numbers');
  for (const g of await tx`SELECT company_id, je_no, entry_date::text AS d, source_type, source_doc_no, account_code, account_name, debit_sen, credit_sen, posted, reversed FROM scm.v_gl_entries WHERE source_doc_no = ANY(${PVS}) ORDER BY je_no, account_code`) {
    out(`GL co${g.company_id} ${g.je_no} ${g.d} ${g.source_type} ${g.source_doc_no} ${g.account_code} ${g.account_name} Dr ${g.debit_sen} Cr ${g.credit_sen} posted=${g.posted} reversed=${g.reversed}`);
  }

  out('── SO payments of SO2608040 / SO2608053, and SO payments of 5,990 / 3,500 / 1,682 from 20/10');
  for (const r of await tx`
    SELECT to_jsonb(p) AS j FROM scm.mfg_sales_order_payments p
     WHERE p.so_doc_no ILIKE '%2608-040%' OR p.so_doc_no ILIKE '%2608040%' OR p.so_doc_no ILIKE '%2608-053%' OR p.so_doc_no ILIKE '%2608053%'
        OR (p.amount_sen IN (599000, 350000, 168200) AND COALESCE(p.paid_at::date, p.created_at::date) >= '2026-10-20')
     ORDER BY p.so_doc_no, p.paid_at`) {
    out(`SOPAY ${pick(r.j, ['company_id', 'id', 'so_doc_no', 'amount_sen', 'paid_at', 'created_at', 'method', 'payment_method', 'account_code', 'bank_account_code', 'deposit_account_code', 'collected_by', 'reference', 'voided', 'status'])}`);
  }

  out('── ledger lines of the same amounts on money accounts, 20/10 – 15/11');
  for (const g of await tx`
    SELECT g.company_id, g.je_no, g.entry_date::text AS d, g.source_type, g.source_doc_no, g.account_code, g.account_name, g.debit_sen, g.credit_sen, g.party_name, g.posted, g.reversed
      FROM scm.v_gl_entries g JOIN scm.accounts a ON a.company_id = g.company_id AND a.account_code = g.account_code AND a.acc_money
     WHERE g.entry_date BETWEEN '2026-10-20' AND '2026-11-15'
       AND (g.debit_sen = ANY(${AMOUNTS}) OR g.credit_sen = ANY(${AMOUNTS}))
     ORDER BY g.entry_date, g.je_no`) {
    out(`GL co${g.company_id} ${g.je_no} ${g.d} ${g.source_type} ${g.source_doc_no ?? '∅'} ${g.account_code} ${g.account_name} Dr ${g.debit_sen} Cr ${g.credit_sen} party=${g.party_name ?? '∅'} posted=${g.posted} reversed=${g.reversed}`);
  }
});
await sql.end();
