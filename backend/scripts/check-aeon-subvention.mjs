#!/usr/bin/env node
// check-aeon-subvention.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06, screenshots of 20261105_000458030287527.csv: AEON's SUBVENTION FEE
// RM 158.48 reads "Merchant charge on no transaction", and its one line (R41797, RM 3,990)
// is "To choose". What the report holds; which payments fit; what the real matcher says;
// how many other reports carry such a charge, on which lines, and what was booked.
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { pgrestShim } from './lib/pgrest-shim.mjs';
import { loadAcquirer, loadPaymentCandidates, loadSettledKeys } from '../src/acc/settlement.ts';
import { matchStatement } from '../src/acc/settlement-match.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const C = 1;

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const sb = pgrestShim(tx, 'scm');
  const [b] = await tx`SELECT * FROM scm.acc_settlement_batches WHERE company_id = ${C} AND file_name ILIKE '%20261105_000458030287527%' ORDER BY id DESC LIMIT 1`;
  if (!b) { out('batch not found'); return; }
  out(`report #${b.id} ${b.file_name} ${day(b.period_from)}..${day(b.period_to)} rows ${b.row_count} gross ${rm(b.gross_sen)} fee ${rm(b.fee_sen)} net ${rm(b.net_sen)} stated ${rm(b.stated_net_sen)} adjustment ${rm(b.adjustment_sen)} je ${b.adjustment_je_no ?? '-'} status ${b.status} uploaded ${String(b.created_at).slice(0, 16)}`);
  const rows = await tx`SELECT * FROM scm.acc_settlement_rows WHERE batch_id = ${b.id} ORDER BY line_no`;
  for (const r of rows) out(`line ${r.line_no} ${day(r.txn_date)} ref ${r.ref} gross ${rm(r.gross_sen)} fee ${rm(r.fee_sen)} net ${rm(r.net_sen)} bucket ${r.bucket} reason ${r.match_reason ?? '-'} | ${String(r.notes ?? '').slice(0, 170)}`);

  /* The payments that could be this swipe. */
  const near = await tx`
    SELECT p.id::text AS id, p.so_doc_no, p.paid_at, p.amount_sen, p.approval_code, p.method, p.merchant_provider, p.collected_by, so.debtor_name, so.salesperson_name
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders so ON so.doc_no = p.so_doc_no
     WHERE p.company_id = ${C} AND (p.approval_code ILIKE '%41797%' OR (p.amount_sen = 399000 AND p.paid_at >= '2026-10-25' AND p.paid_at <= '2026-11-15'))
     ORDER BY p.paid_at`.catch(async () => []);
  out(`payments with that code, or RM 3,990 near that day: ${near.length}`);
  const keys = near.map((p) => `SOPAY:${p.id}`);
  const settled = await loadSettledKeys(sb, C);
  for (const p of near) out(`   ${p.so_doc_no} ${day(p.paid_at)} ${rm(p.amount_sen)} code ${p.approval_code ?? '-'} ${p.method ?? '-'} merchant ${p.merchant_provider ?? '-'} | ${String(p.debtor_name ?? '').slice(0, 28)} | ${String(p.salesperson_name ?? '').slice(0, 20)} | already claimed ${settled.ok && settled.keys.has(`SOPAY:${p.id}`)}`);
  void keys;

  /* What the real matcher says about the line today. */
  const acq = await loadAcquirer(sb, C, 'AEON');
  if (!acq.ok) throw new Error(acq.reason);
  const cfg = { code: 'AEON', has_unique_ref: acq.acquirer.has_unique_ref, date_tolerance_days: acq.acquirer.date_tolerance_days };
  const cands = await loadPaymentCandidates(sb, C, acq.acquirer, day(b.period_from), day(b.period_to), rows.map((r) => r.ref).filter(Boolean));
  if (!cands.ok) throw new Error(cands.reason);
  const taken = new Set(settled.ok ? settled.keys : []);
  const decided = matchStatement(cfg, rows.map((r) => ({ lineNo: Number(r.line_no), txnDate: day(r.txn_date), ref: r.ref, grossSen: Number(r.gross_sen), feeSen: Number(r.fee_sen), netSen: Number(r.net_sen) })), cands.payments, taken);
  for (const d of decided) {
    out(`matcher: line ${d.row.lineNo} ${d.bucket} reason ${d.matchReason ?? '-'} | ${String(d.clue ?? '').slice(0, 200)}`);
    out(`   suggested: ${d.suggested.map((p) => `${p.docNo} ${rm(p.amountSen)} ${day(p.paidOn)} code ${p.approvalCode ?? '-'}`).join('; ') || '-'}`);
    out(`   candidates ${d.candidates.length}: ${d.candidates.slice(0, 8).map((p) => `${p.docNo} ${rm(p.amountSen)} ${day(p.paidOn)} code ${p.approvalCode ?? '-'}`).join('; ') || '-'}`);
  }

  /* Other reports with a charge on no transaction. */
  const adj = await tx`
    SELECT id, company_id, acquirer_code, file_name, period_from, row_count, gross_sen, fee_sen, net_sen, stated_net_sen, adjustment_sen, adjustment_je_no
      FROM scm.acc_settlement_batches WHERE COALESCE(adjustment_sen, 0) <> 0 ORDER BY company_id, acquirer_code, period_from`;
  const tally = {};
  for (const a of adj) {
    const k = `co ${a.company_id} ${a.acquirer_code}`;
    const t = tally[k] ?? (tally[k] = { n: 0, sen: 0, booked: 0, one: 0 });
    t.n += 1; t.sen += Number(a.adjustment_sen); if (a.adjustment_je_no) t.booked += 1; if (Number(a.row_count) === 1) t.one += 1;
  }
  out(`reports with a charge on no transaction: ${JSON.stringify(tally)}`);
  for (const a of adj.filter((x) => x.company_id === C).slice(-14)) {
    const pct = Number(a.gross_sen) ? ((100 * Number(a.adjustment_sen)) / Number(a.gross_sen)).toFixed(2) : '-';
    out(`   #${a.id} ${a.acquirer_code} ${day(a.period_from)} ${a.file_name} lines ${a.row_count} gross ${rm(a.gross_sen)} fee ${rm(a.fee_sen)} charge ${rm(a.adjustment_sen)} (${pct}% of gross) je ${a.adjustment_je_no ?? '-'}`);
  }
  const jes = await tx`
    SELECT je.je_no, je.entry_date, je.source_type, je.source_doc_no, l.account_code, a.account_name, l.debit_sen, l.credit_sen, l.notes
      FROM scm.journal_entries je JOIN scm.journal_entry_lines l ON l.journal_entry_id = je.id LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.account_code
     WHERE je.company_id = ${C} AND je.source_type LIKE 'SETTLEADJ%' ORDER BY je.entry_date DESC, je.je_no, l.line_no LIMIT 4`;
  for (const j of jes) out(`   e.g. ${j.je_no} ${day(j.entry_date)} ${j.source_type} ${j.source_doc_no} ${j.account_code} ${j.account_name ?? ''} Dr ${rm(j.debit_sen)} Cr ${rm(j.credit_sen)} | ${String(j.notes ?? '').slice(0, 70)}`);
  const lines = await tx`SELECT account_code, sum(debit_sen)::bigint AS dr, sum(credit_sen)::bigint AS cr, count(*)::int AS n FROM scm.v_gl_entries WHERE company_id = ${C} AND source_type = 'SETTLEADJ' GROUP BY 1 ORDER BY 1`;
  out(`SETTLEADJ on Houzs: ${lines.map((l) => `${l.account_code} Dr ${rm(l.dr)} Cr ${rm(l.cr)} (${l.n})`).join(', ')}`);
});
await sql.end();
