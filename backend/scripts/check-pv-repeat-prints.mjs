#!/usr/bin/env node
// check-pv-repeat-prints.mjs — READ ONLY (one READ ONLY transaction; mode=apply refused).
// The prints a fix is pinned on (owner 2026-11-10, 2990 HLB October):
//  1. the full words of the three month-end lines the repeat rule missed and of the
//     any-day lines they repeat, plus the later U Mobile bill that must stay its own;
//  2. every OPEN movement whose words carry a voucher number (formal or Draft), with
//     the voucher, its entry on the account, its amount and who holds the entry;
//  3. the audit trail's Draft → formal numbers (CHECK rows of PAYMENT_VOUCHER).
// Env: DATABASE_URL.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
if ((process.env.MODE || 'plan') !== 'plan') { console.error('read-only: run it with mode=plan.'); process.exit(1); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } } });
const row = (...p) => console.log(`ROW|${p.join('|')}`);
const VOUCHER = /\b(?:[A-Z0-9]+-)?(?:[A-Z]{0,2}PV|[A-Z]RF|DRAFT)-\d{4}-\d{2,4}\b/gi;

try {
  await sql.begin('read only', async (tx) => {
    row('-- 1. the prints');
    for (const l of await tx`
      SELECT l.id, l.statement_id, l.line_no, l.booked_on::text AS d, l.amount_sen, to_jsonb(l)->>'state' AS state, l.kind, l.description, l.reference
        FROM scm.acc_bank_statement_lines l
       WHERE l.company_id = 2 AND ((l.statement_id = 23 AND l.line_no IN (6, 8, 34, 68)) OR (l.statement_id = 16 AND l.line_no IN (39, 65, 67)))
       ORDER BY l.booked_on, l.statement_id, l.line_no`) {
      row('PRINT', `line ${l.id}`, `st${l.statement_id} #${l.line_no}`, l.d, l.amount_sen, l.state, l.kind, JSON.stringify(l.description), JSON.stringify(l.reference));
    }

    row('-- 2. OPEN movements naming a voucher');
    const open = await tx`
      SELECT l.id, l.company_id, s.account_code, l.statement_id, l.line_no, l.booked_on::text AS d, l.amount_sen, l.kind, l.description, l.reference
        FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
       WHERE to_jsonb(l)->>'state' = 'OPEN' ORDER BY l.company_id, l.booked_on, l.id`;
    const audit = await tx`
      SELECT a.entity_doc_no, a.field_changes, a.created_at FROM scm.entity_audit_log a
       WHERE a.entity_type = 'PAYMENT_VOUCHER' AND a.field_changes @> '[{"field":"pv_number"}]'::jsonb`;
    const draftOf = new Map();
    for (const a of audit) for (const ch of a.field_changes ?? []) if (ch.field === 'pv_number' && /draft/i.test(String(ch.from ?? ''))) draftOf.set(String(ch.from).toUpperCase(), String(ch.to));
    row('AUDIT', `pv_number changes ${audit.length}`, `draft→formal ${draftOf.size}`, [...draftOf].slice(0, 5).map(([d, f]) => `${d}→${f}`).join(', '));
    for (const l of open) {
      const text = `${l.description ?? ''} ${l.reference ?? ''}`;
      const named = [...new Set((text.match(VOUCHER) ?? []).map((s) => s.toUpperCase()))];
      if (named.length === 0) continue;
      const formal = named.map((n) => (/DRAFT/.test(n) ? draftOf.get(n) ?? `${n}(no formal)` : n));
      const pvs = await tx`
        SELECT v.pv_number, v.status, v.voucher_date::text AS vd, v.total_sen, v.credit_account_code, v.company_id
          FROM scm.payment_vouchers v WHERE upper(v.pv_number) IN ${tx(formal.map((f) => f.toUpperCase()))}
             OR upper(v.pv_number) IN ${tx(formal.map((f) => f.toUpperCase().replace(/^[A-Z0-9]+-(?=[A-Z]{0,2}PV-|[A-Z]RF-)/, '')))}`;
      const jes = await tx`
        SELECT g.je_no, g.entry_date::text AS d, g.source_doc_no, sum(g.debit_sen - g.credit_sen)::bigint AS net
          FROM scm.v_gl_entries g WHERE g.company_id = ${l.company_id} AND g.account_code = ${l.account_code} AND g.source_type = 'PV'
           AND upper(g.source_doc_no) IN ${tx(formal.map((f) => f.toUpperCase()))}
           AND NOT (coalesce(g.reversed, false) OR g.reversed_by_je IS NOT NULL)
         GROUP BY 1, 2, 3`;
      const holders = jes.length === 0 ? [] : await tx`
        SELECT m.je_no, m.bank_line_id FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines x ON x.id = m.bank_line_id
         WHERE m.company_id = ${l.company_id} AND to_jsonb(x)->>'state' = 'POSTED' AND m.je_no IN ${tx(jes.map((j) => j.je_no))}`;
      row('NAMES', `co${l.company_id}`, l.account_code, `line ${l.id} st${l.statement_id} #${l.line_no}`, l.d, l.amount_sen, l.kind, text.replace(/\s+/g, ' ').slice(0, 90),
        `named ${named.join(',')}`, `→ ${formal.join(',')}`,
        pvs.map((v) => `${v.pv_number} co${v.company_id} ${v.status} ${v.vd} ${v.total_sen} ${v.credit_account_code}`).join(' ; ') || 'no voucher',
        jes.map((j) => `${j.je_no} ${j.d} net ${j.net}${Number(j.net) === Number(l.amount_sen) ? ' SAME' : ' differs'}${holders.some((h) => h.je_no === j.je_no) ? ' HELD' : ''}`).join(' ; ') || 'no entry on this account');
    }
  });
  console.log('Read-only: nothing was written.');
} finally {
  await sql.end();
}
