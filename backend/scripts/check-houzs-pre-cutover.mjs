#!/usr/bin/env node
// check-houzs-pre-cutover.mjs — READ ONLY. For the Houzs 31/08 opening (owner
// 2026-10-28 「可以先做开31/08的账先，但是要小心supplier part」): what the ERP's own
// books already hold before 01/09, journal by journal, so the opening counts
// nothing twice.
//   - every posted journal dated before 01/09, by source and month, with the
//     accounts it touches
//   - the customer payments behind SOPAY before 01/09 (method, when keyed)
//   - card clearing 326-0000 at 31/08: which payments are still waiting
//   - other debtors (acc_debtors) and the account roles that matter
// Writes nothing. Env: DATABASE_URL; CUTOFF / COMPANY_ID.
import postgres from 'postgres';

const CUTOFF = process.env.CUTOFF || '2026-08-31';
const CO = Number(process.env.COMPANY_ID || 1);
const rm = (sen) => `RM ${(Number(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const jes = await sql`SELECT j.je_no, j.entry_date::text AS date, j.source_type, j.source_doc_no, j.reversed, j.narration,
        to_char(j.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS keyed,
        json_agg(json_build_object('a', l.account_code, 'dr', l.debit_sen, 'cr', l.credit_sen, 'p', l.party_code) ORDER BY l.line_no) AS lines
      FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
      WHERE j.company_id = ${CO} AND j.posted AND j.entry_date <= ${CUTOFF}
      GROUP BY j.id ORDER BY j.entry_date, j.je_no`;
    for (const j of jes) out('JE', j);

    const pays = await sql`SELECT p.so_doc_no, p.paid_at::text AS paid, p.method, coalesce(p.merchant_provider, '') AS provider, p.amount_sen,
        to_char(p.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS keyed, o.status::text AS so_status, o.so_date::text AS so_date
      FROM scm.mfg_sales_order_payments p LEFT JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no
      WHERE p.company_id = ${CO} AND p.method <> 'imported' AND p.paid_at <= ${CUTOFF} AND p.converted_from_so_doc_no IS NULL
      ORDER BY p.paid_at`;
    for (const p of pays) out('PAY', p);

    const roles = await sql`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = ${CO} ORDER BY role`;
    for (const r of roles) out('ROLE', r);
    const debtors = await sql`SELECT * FROM scm.acc_debtors WHERE company_id = ${CO} ORDER BY 1 LIMIT 200`;
    for (const d of debtors) out('DEBTOR', { code: d.code ?? d.debtor_code, name: d.name ?? d.debtor_name, account: d.account_code ?? d.control_account ?? null });
    const seq = await sql`SELECT * FROM scm.acc_numbering WHERE company_id = ${CO}`.catch((e) => [{ error: e.message }]);
    for (const s of seq) out('NUMBERING', s);
    console.log(`INFO|journals ${jes.length}, payments ${pays.length}, roles ${roles.length}, debtors ${debtors.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
