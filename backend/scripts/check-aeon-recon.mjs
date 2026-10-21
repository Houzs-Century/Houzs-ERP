#!/usr/bin/env node
// check-aeon-recon.mjs — READ-ONLY. Owner 2026-10-21 「aeon merchant 是用什么文件去做
// merchant recon」: how AEON is set up in Merchant Recon (the statement layout it
// reads), what AEON files were uploaded so far, and the AEON payments on Sales
// Orders those files have to cover.
// Writes nothing. Env: DATABASE_URL.
import postgres from 'postgres';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? '—' : String(v).slice(0, 10));

try {
  const cfg = await sql`SELECT * FROM scm.acc_acquirers WHERE code = 'AEON' ORDER BY company_id`;
  console.log('AEON as set up (per company):');
  for (const c of cfg) console.log(`  company ${c.company_id} | active ${c.is_active} | format ${c.statement_format} | fee ${c.fee_method} | tolerance ${c.date_tolerance_days}d | unique ref ${c.has_unique_ref} | columns ${JSON.stringify(c.column_map)} | total line "${c.total_net_label ?? '—'}" | transit ${c.transit_account_code} fee ${c.fee_account_code} bank ${c.bank_account_code}`);

  const batches = await sql`
    SELECT company_id, id, file_name, period_from, period_to, row_count, gross_sen, fee_sen, net_sen, status, uploaded_by, created_at
      FROM scm.acc_settlement_batches WHERE acquirer_code = 'AEON' ORDER BY created_at`;
  console.log(`\nAEON statements uploaded: ${batches.length}`);
  for (const b of batches) console.log(`  co ${b.company_id} #${b.id} "${b.file_name}" ${day(b.period_from)}→${day(b.period_to)} rows ${b.row_count} gross ${rm(b.gross_sen)} fee ${rm(b.fee_sen)} net ${rm(b.net_sen)} ${b.status} by ${b.uploaded_by ?? '—'} on ${day(b.created_at)}`);

  const payouts = await sql`SELECT company_id, file_name, advice_date, gross_sen FROM scm.acc_settlement_payouts WHERE acquirer_code = 'AEON' ORDER BY advice_date`.catch(() => []);
  console.log(`\nAEON payout advices uploaded: ${payouts.length}`);
  for (const p of payouts) console.log(`  co ${p.company_id} "${p.file_name}" ${day(p.advice_date)} ${rm(p.gross_sen)}`);

  const pays = await sql`
    SELECT company_id, to_char(paid_at, 'YYYY-MM') AS month, count(*)::int AS n, sum(amount_sen)::bigint AS sen,
           count(*) FILTER (WHERE coalesce(approval_code, '') = '')::int AS no_code
      FROM scm.mfg_sales_order_payments
     WHERE upper(coalesce(merchant_provider, '')) LIKE '%AEON%' AND paid_at >= '2026-01-01'
     GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log('\nAEON payments on Sales Orders (merchant AEON) by month:');
  for (const p of pays) console.log(`  co ${p.company_id} ${p.month}: ${p.n} payments RM ${rm(p.sen)} (no approval code ${p.no_code})`);
} finally {
  await sql.end();
}
