#!/usr/bin/env node
// check-aeon-tags.mjs — READ-ONLY. Last piece of the AEON question (owner
// 2026-10-21): which merchant the AEON swipes were keyed under on the Sales
// Orders, which merchants each company has set up, and what the "Confirm all"
// runs of this morning actually posted. Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, {
  max: 1, prepare: false,
  types: { date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x } },
});
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));
const ts = (v) => (v instanceof Date ? v.toISOString().slice(0, 19).replace('T', ' ') : v == null ? '—' : String(v).slice(0, 19));

try {
  const acqs = await sql`SELECT company_id, code, display_name, is_active, transit_account_code, fee_account_code, date_tolerance_days FROM scm.acc_acquirers ORDER BY company_id, code`;
  console.log('Merchants set up:');
  for (const a of acqs) console.log(`  co ${a.company_id} ${a.code} "${a.display_name}" active ${a.is_active} transit ${a.transit_account_code ?? '—'} fee ${a.fee_account_code ?? '—'} drift ${a.date_tolerance_days}d`);

  const tags = await sql`
    SELECT company_id, coalesce(nullif(trim(merchant_provider), ''), '(none)') AS tag, method, count(*)::int AS n, sum(amount_sen)::bigint AS sen
      FROM scm.mfg_sales_order_payments
     WHERE paid_at >= '2026-09-01' AND method IN ('merchant', 'installment')
     GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC`;
  console.log('\nCard payments on Sales Orders since 2026-09-01, by merchant keyed:');
  for (const t of tags) console.log(`  co ${t.company_id} ${t.tag} (${t.method}): ${t.n} payments RM ${rm(t.sen)}`);

  const lines = await sql`
    SELECT r.company_id, r.id, r.txn_date, r.ref, r.gross_sen, r.bucket, r.confirmed_at
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE b.acquirer_code = 'AEON'`;
  const refs = [...new Set(lines.map((l) => String(l.ref ?? '').trim()).filter(Boolean))];
  const pays = refs.length === 0 ? [] : await sql`
    SELECT company_id, approval_code, so_doc_no, merchant_provider, method, amount_sen, paid_at
      FROM scm.mfg_sales_order_payments WHERE approval_code IN ${sql(refs)}`;
  const byRef = new Map();
  for (const p of pays) {
    const k = `${p.company_id}|${String(p.approval_code).trim()}`;
    byRef.set(k, [...(byRef.get(k) ?? []), p]);
  }
  const verdict = new Map();
  for (const l of lines) {
    const hits = byRef.get(`${l.company_id}|${String(l.ref ?? '').trim()}`) ?? [];
    const same = hits.filter((h) => Number(h.amount_sen) === Number(l.gross_sen));
    const tag = hits.length === 0 ? 'no payment carries this code'
      : `${same.length > 0 ? 'same amount' : 'different amount'}, keyed ${[...new Set(hits.map((h) => h.merchant_provider ?? '(none)'))].join('/')}`;
    const k = `co ${l.company_id} ${l.bucket}${l.confirmed_at ? ' (confirmed)' : ''} — ${tag}`;
    verdict.set(k, (verdict.get(k) ?? 0) + 1);
  }
  console.log('\nAEON statement lines, by what carries their APP. CODE on the Sales Orders:');
  for (const [k, v] of [...verdict].sort()) console.log(`  ${v}× ${k}`);

  const today = await sql`
    SELECT r.company_id, b.acquirer_code, b.id AS batch_id, r.id, r.txn_date, r.ref, r.gross_sen, r.confirmed_at, r.confirmed_by, r.fee_je_no
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.confirmed_at >= '2026-10-21' ORDER BY r.confirmed_at`.catch(async () => sql`
    SELECT r.company_id, b.acquirer_code, b.id AS batch_id, r.id, r.txn_date, r.ref, r.gross_sen, r.confirmed_at
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.confirmed_at >= '2026-10-21' ORDER BY r.confirmed_at`);
  console.log(`\nLines confirmed today (2026-10-21, UTC times): ${today.length}`);
  for (const t of today) console.log(`  co ${t.company_id} ${t.acquirer_code} #${t.batch_id} line ${t.id} ${day(t.txn_date)} ref ${t.ref ?? '—'} RM ${rm(t.gross_sen)} at ${ts(t.confirmed_at)} ${t.confirmed_by ?? ''} ${t.fee_je_no ?? ''}`);

  const openMatched = await sql`
    SELECT r.company_id, b.acquirer_code, b.id AS batch_id, r.id, r.txn_date, r.ref, r.gross_sen
      FROM scm.acc_settlement_rows r JOIN scm.acc_settlement_batches b ON b.id = r.batch_id
     WHERE r.bucket = 'MATCHED' AND r.confirmed_at IS NULL ORDER BY 1, 2`;
  console.log(`\nMatched lines still waiting to be posted: ${openMatched.length}`);
  for (const o of openMatched) console.log(`  co ${o.company_id} ${o.acquirer_code} #${o.batch_id} line ${o.id} ${day(o.txn_date)} ref ${o.ref ?? '—'} RM ${rm(o.gross_sen)}`);

  const je = await sql`
    SELECT company_id, source_type, count(*)::int AS n, min(created_at) AS first, max(created_at) AS last
      FROM scm.journal_entries WHERE created_at >= '2026-10-21 02:50' AND created_at < '2026-10-21 04:10'
       AND source_type IN ('SETTLEADJ', 'SETTLE', 'SETTLEMENT', 'SETTLEMOVE', 'SETTLEFEE')
     GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log('\nSettlement entries made 02:50–04:10 UTC today:');
  for (const j of je) console.log(`  co ${j.company_id} ${j.source_type}: ${j.n} (${ts(j.first)} → ${ts(j.last)})`);
  const kinds = await sql`
    SELECT source_type, count(*)::int AS n FROM scm.journal_entries
     WHERE created_at >= '2026-10-21 02:50' AND created_at < '2026-10-21 04:10' GROUP BY 1 ORDER BY 2 DESC`;
  console.log(`  every kind made in that window: ${kinds.map((k) => `${k.source_type} ${k.n}`).join(', ')}`);
} finally {
  await sql.end();
}
