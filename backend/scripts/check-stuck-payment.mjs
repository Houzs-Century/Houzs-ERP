#!/usr/bin/env node
// check-stuck-payment.mjs — READ ONLY. Why one order's payments sit on the
// Unmatched payments list (owner 2026-11-02: 「这个还没有match 到吗？」 on
// 2990-SO-2607-027, RM 125 transfer + RM 1,933 PBB card, paid 11/06/2026).
// For each payment of the order: its row, its journal entry and money account,
// what Merchant Recon / Bank Recon hold that could be it (same amount near the
// day, or its reference), and how far the statements / merchant reports reach.
// Nothing is written. Env: DATABASE_URL, COMPANY_ID (2), SO_DOC.
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 2);
const DOC = String(process.env.SO_DOC || '2990-SO-2607-027');
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (sen == null ? '—' : (Number(sen) / 100).toFixed(2));
const day = (v) => (v == null ? '—' : (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10));
const pick = (r, keys) => keys.filter((k) => k in r).map((k) => `${k}=${r[k] instanceof Date ? r[k].toISOString() : r[k]}`).join(' ');

try {
  const pays = await sql`SELECT * FROM scm.mfg_sales_order_payments WHERE company_id = ${CO} AND so_doc_no = ${DOC} ORDER BY paid_at, id`;
  out(`== ${DOC} (company ${CO}): ${pays.length} payment(s)`);
  for (const p of pays) {
    out(`-- payment ${p.id}: ${pick(p, ['method', 'merchant_provider', 'online_type', 'amount_sen', 'approval_code', 'reference', 'paid_at', 'status', 'created_at', 'notes'])}`);
    const jes = await sql`SELECT id, je_no, entry_date, posted, reversed FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'SOPAY' AND source_doc_no = ${String(p.id)} ORDER BY id`;
    for (const j of jes) {
      const legs = await sql`SELECT account_code, debit_sen, credit_sen FROM scm.journal_entry_lines WHERE journal_entry_id = ${j.id} ORDER BY id`;
      out(`   JE ${j.je_no} ${day(j.entry_date)} posted=${j.posted} reversed=${j.reversed} legs: ${legs.map((l) => `${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)}`).join(' | ')}`);
    }
    const sm = await sql`SELECT * FROM scm.acc_settlement_matches WHERE company_id = ${CO} AND payment_id = ${String(p.id)}`;
    out(`   merchant links: ${sm.length ? sm.map((m) => pick(m, ['settlement_row_id', 'amount_sen', 'doc_no'])).join(' ; ') : 'none'}`);
    const paid = day(p.paid_at);
    const amount = Number(p.amount_sen);
    const method = String(p.method ?? '');
    if (method !== 'transfer') {
      const prov = String(p.merchant_provider ?? '');
      const batches = await sql`SELECT id, acquirer_code, file_name, period_from, period_to, row_count, status, created_at FROM scm.acc_settlement_batches WHERE company_id = ${CO} ORDER BY acquirer_code, period_from`;
      const byAcq = new Map();
      for (const b of batches) { const a = byAcq.get(b.acquirer_code) ?? []; a.push(`${day(b.period_from)}..${day(b.period_to)}`); byAcq.set(b.acquirer_code, a); }
      for (const [a, list] of byAcq) out(`   merchant reports ${a}: ${list.length} — ${list.slice(-8).join(', ')}${list.length > 8 ? ' (last 8)' : ''}`);
      const acq = await sql`SELECT * FROM scm.acc_acquirers WHERE company_id = ${CO}`;
      out(`   merchants: ${acq.map((a) => pick(a, ['code', 'acquirer_code', 'display_name', 'so_names', 'is_active'])).join(' ; ')}`);
      const near = await sql`
        SELECT r.*, b.file_name FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
         WHERE r.company_id = ${CO} AND r.txn_date BETWEEN ${paid}::date - 10 AND ${paid}::date + 10
           AND (r.gross_sen = ${amount} OR r.ref ILIKE ${'%' + String(p.approval_code ?? 'zzzz') + '%'})
         ORDER BY r.txn_date, r.id`;
      out(`   merchant rows near ${paid} for ${rm(amount)} or ref ${p.approval_code ?? '—'}: ${near.length}`);
      for (const r of near) {
        const claims = await sql`SELECT payment_id, doc_no, amount_sen FROM scm.acc_settlement_matches WHERE settlement_row_id = ${r.id}`;
        out(`     row ${r.id} ${r.acquirer_code} ${day(r.txn_date)} ref=${r.ref} gross ${rm(r.gross_sen)} bucket=${r.bucket} reason=${r.match_reason} confirmed=${r.confirmed_at ? 'yes' : 'no'} je=${r.posted_je_no ?? '—'} file=${r.file_name} claims: ${claims.map((c) => `${c.doc_no} ${rm(c.amount_sen)}`).join(', ') || 'none'}`);
      }
      const anyRef = await sql`SELECT r.id, r.acquirer_code, r.txn_date, r.ref, r.gross_sen, r.bucket FROM scm.acc_settlement_rows r WHERE r.company_id = ${CO} AND r.ref ILIKE ${'%' + String(p.approval_code ?? 'zzzz') + '%'}`;
      out(`   any merchant row with ref ${p.approval_code ?? '—'} (any date): ${anyRef.map((r) => `${r.id} ${r.acquirer_code} ${day(r.txn_date)} ${r.ref} ${rm(r.gross_sen)} ${r.bucket}`).join(' ; ') || 'none'}`);
      const sameDay = await sql`SELECT r.acquirer_code, count(*)::int AS n, sum(r.gross_sen)::bigint AS gross FROM scm.acc_settlement_rows r WHERE r.company_id = ${CO} AND r.txn_date = ${paid}::date GROUP BY 1 ORDER BY 1`;
      out(`   merchant rows dated ${paid}: ${sameDay.map((s) => `${s.acquirer_code} ${s.n} rows ${rm(s.gross)}`).join(' ; ') || 'none'}`);
    } else {
      const je = jes.find((j) => !j.reversed);
      const legs = je ? await sql`SELECT account_code, debit_sen FROM scm.journal_entry_lines WHERE journal_entry_id = ${je.id} AND debit_sen > 0 ORDER BY id LIMIT 1` : [];
      const acct = legs[0]?.account_code ?? null;
      out(`   money account ${acct ?? '—'}`);
      const stmts = await sql`SELECT id, account_code, file_name, period_from, period_to, line_count, status, created_at FROM scm.acc_bank_statements WHERE company_id = ${CO} ORDER BY account_code, period_from`;
      const byAcct = new Map();
      for (const s of stmts) { const a = byAcct.get(s.account_code) ?? []; a.push(`${day(s.period_from)}..${day(s.period_to)}#${s.id}`); byAcct.set(s.account_code, a); }
      for (const [a, list] of byAcct) out(`   statements ${a}: ${list.join(', ')}`);
      const cands = await sql`
        SELECT l.*, s.account_code FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.amount_sen = ${amount} AND l.booked_on BETWEEN ${paid}::date - 10 AND ${paid}::date + 30
         ORDER BY l.booked_on, l.id`;
      out(`   bank lines of +${rm(amount)} from ${paid} −10 to +30 days: ${cands.length}`);
      for (const l of cands) {
        const ms = await sql`SELECT je_no FROM scm.acc_bank_statement_matches WHERE company_id = ${CO} AND bank_line_id = ${l.id}`;
        out(`     line ${l.id} ${l.account_code} ${day(l.booked_on)} "${String(l.description).slice(0, 80)}" ref=${l.reference ?? '—'} state=${l.state} posted_je=${l.posted_je_no ?? '—'} matches: ${ms.map((m) => m.je_no).join(', ') || 'none'}`);
      }
      const ref = String(p.reference ?? p.approval_code ?? '').trim();
      if (ref) {
        const byRef = await sql`
          SELECT l.id, s.account_code, l.booked_on, l.amount_sen, l.state, l.description, l.reference FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
           WHERE l.company_id = ${CO} AND (l.reference ILIKE ${'%' + ref + '%'} OR l.description ILIKE ${'%' + ref + '%'})`;
        out(`   bank lines naming ${ref}: ${byRef.map((l) => `${l.id} ${l.account_code} ${day(l.booked_on)} ${rm(l.amount_sen)} ${l.state} "${String(l.description).slice(0, 60)}"`).join(' ; ') || 'none'}`);
      }
      const sameDay = await sql`
        SELECT s.account_code, count(*)::int AS n, sum(CASE WHEN l.amount_sen > 0 THEN l.amount_sen ELSE 0 END)::bigint AS inflow
          FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.booked_on BETWEEN ${paid}::date AND ${paid}::date + 3 GROUP BY 1 ORDER BY 1`;
      out(`   bank lines ${paid}..+3 by account: ${sameDay.map((s) => `${s.account_code} ${s.n} lines in ${rm(s.inflow)}`).join(' ; ') || 'none'}`);
      const small = await sql`
        SELECT l.id, s.account_code, l.booked_on, l.amount_sen, l.state, l.description FROM scm.acc_bank_statement_lines l JOIN scm.acc_bank_statements s ON s.id = l.statement_id
         WHERE l.company_id = ${CO} AND l.booked_on BETWEEN ${paid}::date - 3 AND ${paid}::date + 5 AND l.amount_sen > 0 AND l.amount_sen <= 50000
         ORDER BY l.booked_on, l.id`;
      out(`   small credits (≤ RM 500) ${paid} −3..+5: ${small.length}`);
      for (const l of small) out(`     ${l.id} ${l.account_code} ${day(l.booked_on)} ${rm(l.amount_sen)} ${l.state} "${String(l.description).slice(0, 70)}"`);
    }
  }
} catch (e) {
  out(`FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
