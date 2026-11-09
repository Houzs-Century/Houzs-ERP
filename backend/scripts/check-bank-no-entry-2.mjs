#!/usr/bin/env node
// check-bank-no-entry-2.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-09 (Bank recon "No entry found", 然后像这种我该如何match?), second look:
// 2990's HLB statement lines from 20/10 (with what each is matched to), the ledger lines
// on 2990's HLB that no bank line holds yet, the SO payments behind GAN LE SIANG and
// TAN ENG SIANG and who the orders are for, any order for VERO MEDICAL, the PV's own dates,
// and every bank line anywhere that carries a charge but is not a card payout (a credit
// and a debit joined by mistake as gross and fee).
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const CO = 2;
const HLB = '310-0020';

await sql.begin('READ ONLY', async (tx) => {
  out('── 2990 HLB statement lines from 20/10, with what each is matched to');
  for (const l of await tx`
    SELECT l.id, l.statement_id, l.line_no, l.booked_on::text AS d, l.description, l.reference, l.amount_sen, l.charge_sen, l.kind,
           to_jsonb(l)->>'state' AS state,
           (SELECT string_agg(m.je_no || ':' || m.amount_sen || ':' || COALESCE(m.match_reason, ''), ', ') FROM scm.acc_bank_statement_matches m WHERE m.bank_line_id = l.id) AS matched
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.company_id = ${CO} AND s.account_code = ${HLB} AND l.booked_on >= '2026-10-20'
     ORDER BY l.booked_on, l.line_no`) {
    out(`${l.d} st${l.statement_id} #${l.line_no} [${l.state}/${l.kind}] ${l.amount_sen}${Number(l.charge_sen) ? ` charge ${l.charge_sen}` : ''} | ${l.description} | ref=${l.reference ?? '∅'} | ${l.matched ?? 'not matched'}`);
  }

  out('── ledger lines on 2990 HLB from 01/10 that no bank line holds');
  for (const g of await tx`
    SELECT g.je_no, g.entry_date::text AS d, g.source_type, g.source_doc_no, g.debit_sen - g.credit_sen AS net, g.party_name, g.reversed
      FROM scm.v_gl_entries g
     WHERE g.company_id = ${CO} AND g.account_code = ${HLB} AND g.entry_date >= '2026-10-01' AND g.posted
       AND NOT EXISTS (SELECT 1 FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id
                        WHERE m.company_id = g.company_id AND m.je_no = g.je_no AND to_jsonb(l)->>'state' = 'POSTED')
     ORDER BY g.entry_date, g.je_no`) {
    out(`${g.d} ${g.je_no} ${g.source_type} ${g.source_doc_no ?? '∅'} ${g.net} party=${g.party_name ?? '∅'} reversed=${g.reversed}`);
  }

  out('── the SO payments behind the bank lines, the ledger account each went to, the order\'s debtor');
  for (const p of await tx`
    SELECT p.id, p.so_doc_no, p.amount_sen, p.paid_at::text AS paid, o.debtor_name,
           (SELECT string_agg(g.je_no || ' ' || g.entry_date::text || ' ' || g.account_code || ' ' || (g.debit_sen - g.credit_sen), '; ')
              FROM scm.v_gl_entries g WHERE g.company_id = p.company_id AND g.source_doc_no = p.id::text AND g.account_code LIKE '31%') AS gl
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
     WHERE p.company_id = ${CO} AND p.so_doc_no IN ('2990-SO-2608-040', '2990-SO-2608-053', '2990-SO-2609-042')
     ORDER BY p.so_doc_no, p.paid_at`) {
    out(`${p.so_doc_no} ${p.debtor_name ?? '∅'} | pay ${p.id} ${p.amount_sen} on ${p.paid} | ${p.gl ?? 'no money-account line'}`);
  }
  out('── orders for VERO MEDICAL, TAN ENG SIANG, GAN LE SIANG (either company)');
  for (const o of await tx`
    SELECT o.company_id, o.doc_no, o.debtor_name, (SELECT string_agg(p.amount_sen || '@' || p.paid_at::date, ', ') FROM scm.mfg_sales_order_payments p WHERE p.so_doc_no = o.doc_no) AS pays
      FROM scm.mfg_sales_orders o
     WHERE upper(o.debtor_name) LIKE '%VERO%' OR upper(o.debtor_name) LIKE '%TAN ENG SIANG%' OR upper(o.debtor_name) LIKE '%GAN LE SIANG%'
     ORDER BY o.doc_no`) {
    out(`co${o.company_id} ${o.doc_no} ${o.debtor_name} | payments ${o.pays ?? 'none'}`);
  }

  out('── the two PVs: their own dates');
  for (const r of await tx`SELECT to_jsonb(v) AS j FROM scm.payment_vouchers v WHERE v.pv_number IN ('2990-HPV-2610-026', '2990-HPV-2611-011')`) {
    const j = r.j;
    out(`${j.pv_number} ${Object.entries(j).filter(([k, v]) => /date|_at$|_on$|paid|bank|account|method|amount|total/.test(k) && v !== null).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ')}`);
  }

  out('── bank lines anywhere with a charge that are not card payouts (a credit and a debit joined as gross and fee)');
  for (const l of await tx`
    SELECT l.company_id, s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.description, l.reference, l.amount_sen, l.charge_sen, l.kind, to_jsonb(l)->>'state' AS state
      FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
     WHERE l.charge_sen > 0 AND l.kind NOT IN ('PAYOUT', 'PAYOUT_UNSURE', 'PAYOUT_NO_BATCH')
     ORDER BY l.company_id, l.booked_on, l.line_no`) {
    out(`co${l.company_id} ${l.account_code} ${l.d} st${l.statement_id} #${l.line_no} [${l.state}/${l.kind}] net ${l.amount_sen} charge ${l.charge_sen} | ${l.description} | ref=${l.reference ?? '∅'}`);
  }
});
await sql.end();
