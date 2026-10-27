#!/usr/bin/env node
// check-houzs-sep-state.mjs — READ ONLY. Owner 2026-10-27: 「我现在想要开始导入houzs
// 9月的数据了」. Before anything is imported: what does the ERP already hold for
// Houzs (company 1) in September 2026, and what does the opening look like?
//   - posted journals dated in the month, by source (what the ERP books itself)
//   - payment vouchers, AP invoices, purchase / sales invoices in the month
//   - anything dated on or before 31/08 that looks like an opening entry
//   - bank: statement set-up, statements, month locks, voucher letters
//   - card settlement batches (Merchant Recon) by period
// Writes nothing. Env: DATABASE_URL; FROM / TO / COMPANY_ID override the window.
import postgres from 'postgres';

const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function section(name, fn) {
  try { await fn(); } catch (e) { console.log(`ROW|${name}: FAILED ${e.message}`); }
}

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const columnsOf = async (table) =>
    (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${table} ORDER BY ordinal_position`).map((r) => r.column_name);
  try {
    console.log(`ROW|window ${FROM} .. ${TO}, company ${CO}`);

    await section('journals in the month', async () => {
      const rows = await sql`SELECT j.source_type, count(DISTINCT j.id)::int AS n,
          count(DISTINCT j.id) FILTER (WHERE j.reversed)::int AS rev,
          coalesce(sum(l.debit_sen), 0)::bigint AS dr
        FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
        WHERE j.company_id = ${CO} AND j.posted AND j.entry_date >= ${FROM} AND j.entry_date <= ${TO}
        GROUP BY 1 ORDER BY 1`;
      for (const r of rows) console.log(`ROW|journal ${r.source_type}: ${r.n} entries (${r.rev} reversed) Dr ${rm(r.dr)}`);
      const unposted = await sql`SELECT source_type, count(*)::int AS n FROM scm.journal_entries
        WHERE company_id = ${CO} AND NOT posted AND entry_date >= ${FROM} AND entry_date <= ${TO} GROUP BY 1 ORDER BY 1`;
      for (const r of unposted) console.log(`ROW|journal NOT posted ${r.source_type}: ${r.n}`);
    });

    await section('pnl accounts in the month', async () => {
      const rows = await sql`SELECT a.account_type, count(*)::int AS n,
          coalesce(sum(l.debit_sen), 0)::bigint AS dr, coalesce(sum(l.credit_sen), 0)::bigint AS cr
        FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
        JOIN scm.accounts a ON a.account_code = l.account_code
        WHERE j.company_id = ${CO} AND j.posted AND j.entry_date >= ${FROM} AND j.entry_date <= ${TO}
        GROUP BY 1 ORDER BY 1`;
      for (const r of rows) console.log(`ROW|by account type ${r.account_type}: ${r.n} lines Dr ${rm(r.dr)} Cr ${rm(r.cr)}`);
    });

    await section('opening-like entries', async () => {
      const rows = await sql`SELECT source_type, min(entry_date)::text AS first, max(entry_date)::text AS last, count(*)::int AS n
        FROM scm.journal_entries WHERE company_id = ${CO} AND posted AND entry_date < ${FROM}
        GROUP BY 1 ORDER BY 1`;
      for (const r of rows) console.log(`ROW|before ${FROM} ${r.source_type}: ${r.n} entries ${r.first}..${r.last}`);
    });

    await section('payment vouchers', async () => {
      const rows = await sql`SELECT status::text AS st, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen
        FROM scm.payment_vouchers WHERE company_id = ${CO} AND voucher_date >= ${FROM} AND voucher_date <= ${TO}
        GROUP BY 1 ORDER BY 1`;
      for (const r of rows) console.log(`ROW|PV dated in month ${r.st}: ${r.n} ${rm(r.sen)}`);
      const byBank = await sql`SELECT credit_account_code AS acc, purpose::text AS purpose, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen
        FROM scm.payment_vouchers WHERE company_id = ${CO} AND voucher_date >= ${FROM} AND voucher_date <= ${TO}
        GROUP BY 1, 2 ORDER BY 1, 2`;
      for (const r of byBank) console.log(`ROW|  PV from ${r.acc} ${r.purpose}: ${r.n} ${rm(r.sen)}`);
      const created = await sql`SELECT to_char(created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM') AS m, count(*)::int AS n
        FROM scm.payment_vouchers WHERE company_id = ${CO} AND voucher_date >= ${FROM} AND voucher_date <= ${TO} GROUP BY 1 ORDER BY 1`;
      for (const r of created) console.log(`ROW|  PV dated in month, keyed in ${r.m}: ${r.n}`);
      const after = await sql`SELECT to_char(voucher_date, 'YYYY-MM') AS m, status::text AS st, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen
        FROM scm.payment_vouchers WHERE company_id = ${CO} AND voucher_date > ${TO} GROUP BY 1, 2 ORDER BY 1, 2`;
      for (const r of after) console.log(`ROW|  PV later ${r.m} ${r.st}: ${r.n} ${rm(r.sen)}`);
    });

    await section('pv allocations', async () => {
      const r = await sql`SELECT count(DISTINCT a.pv_id)::int AS pvs, count(*)::int AS n
        FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
        WHERE v.company_id = ${CO} AND v.voucher_date >= ${FROM} AND v.voucher_date <= ${TO}`;
      console.log(`ROW|  PV dated in month that apply to bills: ${r[0].pvs} (${r[0].n} allocations)`);
    });

    await section('unpaid bills', async () => {
      for (const t of ['purchase_invoices', 'ap_invoices']) {
        const rows = await sql.unsafe(
          `SELECT CASE WHEN invoice_date < $2 THEN 'before' WHEN invoice_date <= $3 THEN 'in month' ELSE 'after' END AS w,
              count(*)::int AS n, coalesce(sum(total_sen - paid_sen), 0)::bigint AS owed
           FROM scm.${t} WHERE company_id = $1 AND status NOT IN ('CANCELLED', 'DRAFT', 'PAID') AND total_sen > paid_sen
           GROUP BY 1 ORDER BY 1`, [CO, FROM, TO]);
        for (const r of rows) console.log(`ROW|${t} unpaid, dated ${r.w}: ${r.n} owed ${rm(r.owed)}`);
      }
      const mig = await sql`SELECT count(*)::int AS n, coalesce(sum(total_sen - paid_sen), 0)::bigint AS owed
        FROM scm.purchase_invoices WHERE company_id = ${CO} AND migrated_no_stock AND status NOT IN ('CANCELLED', 'PAID') AND total_sen > paid_sen`;
      console.log(`ROW|  of which migrated from AutoCount (no stock): ${mig[0].n} owed ${rm(mig[0].owed)}`);
    });

    await section('AP invoices', async () => {
      const rows = await sql`SELECT status, count(*)::int AS n, coalesce(sum(total_sen), 0)::bigint AS sen
        FROM scm.ap_invoices WHERE company_id = ${CO} AND invoice_date >= ${FROM} AND invoice_date <= ${TO}
        GROUP BY 1 ORDER BY 1`;
      for (const r of rows) console.log(`ROW|AP invoice dated in month ${r.status}: ${r.n} ${rm(r.sen)}`);
    });

    for (const table of ['purchase_invoices', 'sales_invoices']) {
      await section(table, async () => {
        const cols = await columnsOf(table);
        console.log(`ROW|${table} columns: ${cols.join(', ')}`);
        const dateCol = ['invoice_date', 'pi_date', 'si_date', 'doc_date', 'date'].find((c) => cols.includes(c));
        const totalCol = ['total_sen', 'grand_total_sen', 'local_total_sen', 'total_sen', 'amount_sen'].find((c) => cols.includes(c));
        const statusCol = cols.includes('status') ? 'status' : null;
        const coCol = cols.includes('company_id') ? 'company_id' : null;
        if (!dateCol || !coCol) { console.log(`ROW|${table}: no date or company column`); return; }
        const rows = await sql.unsafe(
          `SELECT ${statusCol ? `${statusCol}::text` : `'-'`} AS st, count(*)::int AS n${totalCol ? `, coalesce(sum(${totalCol}), 0)::bigint AS sen` : ''}
           FROM scm.${table} WHERE ${coCol} = $1 AND ${dateCol} >= $2 AND ${dateCol} <= $3 GROUP BY 1 ORDER BY 1`,
          [CO, FROM, TO]
        );
        for (const r of rows) console.log(`ROW|${table} dated in month (${dateCol}) ${r.st}: ${r.n}${totalCol ? ` ${rm(r.sen)} (${totalCol})` : ''}`);
      });
    }

    await section('bank', async () => {
      const cfg = await sql`SELECT account_code, bank_code, statement_format, is_active FROM scm.acc_bank_statement_config WHERE company_id = ${CO} ORDER BY 1`;
      console.log(`ROW|bank statement set-up: ${cfg.length ? cfg.map((r) => `${r.account_code} ${r.bank_code} ${r.statement_format}${r.is_active ? '' : ' (off)'}`).join('; ') : 'none'}`);
      const st = await sql`SELECT account_code, count(*)::int AS n, min(period_from)::text AS f, max(period_to)::text AS t FROM scm.acc_bank_statements WHERE company_id = ${CO} GROUP BY 1 ORDER BY 1`;
      console.log(`ROW|bank statements: ${st.length ? st.map((r) => `${r.account_code} ${r.n} (${r.f}..${r.t})`).join('; ') : 'none'}`);
      const lk = await sql`SELECT account_code, to_char(period_month, 'YYYY-MM') AS m FROM scm.acc_bank_month_locks WHERE company_id = ${CO} AND released_at IS NULL ORDER BY 1, 2`;
      console.log(`ROW|bank month locks: ${lk.length ? lk.map((r) => `${r.account_code} ${r.m}`).join('; ') : 'none'}`);
      const letters = await sql`SELECT account_code, letter FROM scm.acc_bank_letters WHERE company_id = ${CO} ORDER BY 1`;
      console.log(`ROW|voucher letters: ${letters.length ? letters.map((r) => `${r.account_code}=${r.letter}`).join('; ') : 'none'}`);
      const banks = await sql`SELECT a.account_code, a.account_name,
          coalesce(sum(l.debit_sen - l.credit_sen) FILTER (WHERE j.entry_date < ${FROM}), 0)::bigint AS before,
          coalesce(sum(l.debit_sen) FILTER (WHERE j.entry_date >= ${FROM} AND j.entry_date <= ${TO}), 0)::bigint AS dr,
          coalesce(sum(l.credit_sen) FILTER (WHERE j.entry_date >= ${FROM} AND j.entry_date <= ${TO}), 0)::bigint AS cr
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        JOIN scm.accounts a ON a.account_code = l.account_code
        WHERE j.company_id = ${CO} AND j.posted AND l.account_code LIKE '310-%'
        GROUP BY 1, 2 ORDER BY 1`;
      for (const r of banks) console.log(`ROW|bank ${r.account_code} ${r.account_name}: before ${FROM} ${rm(r.before)}; in month Dr ${rm(r.dr)} Cr ${rm(r.cr)}`);
    });

    await section('card settlement', async () => {
      const rows = await sql`SELECT acquirer_code, to_char(period_from, 'YYYY-MM') AS m, status, count(*)::int AS n, coalesce(sum(gross_sen), 0)::bigint AS g
        FROM scm.acc_settlement_batches WHERE company_id = ${CO} GROUP BY 1, 2, 3 ORDER BY 2, 1, 3`;
      for (const r of rows) console.log(`ROW|settlement ${r.m} ${r.acquirer_code} ${r.status}: ${r.n} files gross ${rm(r.g)}`);
      if (!rows.length) console.log('ROW|settlement: none');
      const clr = await sql`SELECT coalesce(sum(l.debit_sen - l.credit_sen), 0)::bigint AS bal
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        WHERE j.company_id = ${CO} AND j.posted AND l.account_code = '326-0000' AND j.entry_date <= ${TO}`;
      console.log(`ROW|card clearing 326-0000 balance at ${TO}: ${rm(clr[0].bal)}`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
