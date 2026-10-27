#!/usr/bin/env node
// export-houzs-erp-side.mjs — READ ONLY. Owner 2026-10-27: Houzs September is to
// be brought in from AutoCount's General Ledger (「所以我要给你什么？ general
// ledger?」 → one GL export, all accounts). This prints the ERP's side of that
// comparison, one record per line (prefix|json), so the AutoCount file can be
// joined to it offline:
//   ACC   per account: balance before FROM, Dr / Cr in the window (posted only)
//   CHART the company's accounts (code, name, type, section)
//   SUP   suppliers (id, code, name) — an AutoCount creditor account is a code
//   PI    purchase invoices dated around the window, with linked_ac_docno
//   SI    sales invoices dated in the window, with linked_ac_docno
//   API   AP invoices dated around the window, supplier + their own ref
//   PV    payment vouchers dated in the window
//   JE    every posted journal dated in the window: number, date, source, doc, Dr
// Writes nothing. Env: DATABASE_URL; FROM / TO / COMPANY_ID override.
import postgres from 'postgres';

const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const AROUND_FROM = process.env.AROUND_FROM || '2026-08-01';
const AROUND_TO = process.env.AROUND_TO || '2026-10-31';
const CO = Number(process.env.COMPANY_ID || 1);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);

async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  const columnsOf = async (table) =>
    new Set((await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${table}`).map((r) => r.column_name));
  const pick = (cols, wanted) => wanted.filter((c) => cols.has(c));
  try {
    console.log(`INFO|window ${FROM} .. ${TO}, around ${AROUND_FROM} .. ${AROUND_TO}, company ${CO}`);

    const acc = await sql`SELECT l.account_code AS code,
        coalesce(sum(l.debit_sen - l.credit_sen) FILTER (WHERE j.entry_date < ${FROM}), 0)::bigint AS before,
        coalesce(sum(l.debit_sen) FILTER (WHERE j.entry_date >= ${FROM} AND j.entry_date <= ${TO}), 0)::bigint AS dr,
        coalesce(sum(l.credit_sen) FILTER (WHERE j.entry_date >= ${FROM} AND j.entry_date <= ${TO}), 0)::bigint AS cr
      FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = ${CO} AND j.posted AND j.entry_date <= ${TO}
      GROUP BY 1 ORDER BY 1`;
    for (const r of acc) out('ACC', { code: r.code, before: Number(r.before), dr: Number(r.dr), cr: Number(r.cr) });

    {
      const cols = await columnsOf('accounts');
      const sel = pick(cols, ['account_code', 'account_name', 'account_type', 'section', 'parent_code', 'parent_account_code', 'is_group', 'is_active', 'company_id', 'special_type', 'acc_money']);
      const rows = await sql.unsafe(`SELECT ${sel.join(', ')} FROM scm.accounts ${cols.has('company_id') ? 'WHERE company_id = $1 OR company_id IS NULL' : ''} ORDER BY account_code`, cols.has('company_id') ? [CO] : []);
      for (const r of rows) out('CHART', r);
    }

    {
      const cols = await columnsOf('suppliers');
      const sel = pick(cols, ['id', 'code', 'name', 'company_id', 'currency', 'for_purchasing']);
      const rows = await sql.unsafe(`SELECT ${sel.join(', ')} FROM scm.suppliers ${cols.has('company_id') ? 'WHERE company_id = $1' : ''} ORDER BY code`, cols.has('company_id') ? [CO] : []);
      for (const r of rows) out('SUP', r);
    }

    const pis = await sql`SELECT p.invoice_number, p.linked_ac_docno, p.supplier_invoice_ref, p.invoice_date::text AS date, s.code AS supplier,
        p.total_sen, p.paid_sen, p.status::text AS status, p.migrated_no_stock, p.currency
      FROM scm.purchase_invoices p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
      WHERE p.company_id = ${CO} AND p.invoice_date >= ${AROUND_FROM} AND p.invoice_date <= ${AROUND_TO}
      ORDER BY p.invoice_date, p.invoice_number`;
    for (const r of pis) out('PI', { ...r, total_sen: Number(r.total_sen), paid_sen: Number(r.paid_sen) });

    const sis = await sql`SELECT invoice_number, linked_ac_docno, so_doc_no, invoice_date::text AS date, debtor_code, total_sen, paid_sen, status::text AS status
      FROM scm.sales_invoices WHERE company_id = ${CO} AND invoice_date >= ${FROM} AND invoice_date <= ${TO}
      ORDER BY invoice_date, invoice_number`;
    for (const r of sis) out('SI', { ...r, total_sen: Number(r.total_sen), paid_sen: Number(r.paid_sen) });

    const apis = await sql`SELECT a.invoice_number, a.supplier_invoice_ref, a.invoice_date::text AS date, s.code AS supplier, s.name AS supplier_name,
        a.total_sen, a.paid_sen, a.status, a.currency
      FROM scm.ap_invoices a LEFT JOIN scm.suppliers s ON s.id = a.supplier_id
      WHERE a.company_id = ${CO} AND a.invoice_date >= ${AROUND_FROM} AND a.invoice_date <= ${AROUND_TO}
      ORDER BY a.invoice_date, a.invoice_number`;
    for (const r of apis) out('API', { ...r, total_sen: Number(r.total_sen), paid_sen: Number(r.paid_sen) });

    const pvs = await sql`SELECT v.pv_number, v.voucher_date::text AS date, v.payee_name, v.credit_account_code, v.purpose::text AS purpose,
        v.status::text AS status, v.total_sen, s.code AS supplier
      FROM scm.payment_vouchers v LEFT JOIN scm.suppliers s ON s.id = v.supplier_id
      WHERE v.company_id = ${CO} AND v.voucher_date >= ${FROM} AND v.voucher_date <= ${TO}
      ORDER BY v.voucher_date, v.pv_number`;
    for (const r of pvs) out('PV', { ...r, total_sen: Number(r.total_sen) });

    const jes = await sql`SELECT j.je_no, j.entry_date::text AS date, j.source_type, j.source_doc_no, j.reversed,
        coalesce(sum(l.debit_sen), 0)::bigint AS dr
      FROM scm.journal_entries j JOIN scm.journal_entry_lines l ON l.journal_entry_id = j.id
      WHERE j.company_id = ${CO} AND j.posted AND j.entry_date >= ${FROM} AND j.entry_date <= ${TO}
      GROUP BY j.id ORDER BY j.entry_date, j.je_no`;
    for (const r of jes) out('JE', { ...r, dr: Number(r.dr) });

    console.log(`INFO|counts ACC ${acc.length} PI ${pis.length} SI ${sis.length} API ${apis.length} PV ${pvs.length} JE ${jes.length}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
