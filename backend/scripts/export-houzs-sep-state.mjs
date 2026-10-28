#!/usr/bin/env node
/* export-houzs-sep-state.mjs — READ ONLY. Owner 2026-10-28: 「开始导入9月的资料」
   — the books start 01/09 and the opening is in; AutoCount's September papers
   are to come in where the ERP lacks them. This prints what the ERP holds for
   the window today, one record per line (TAG|json), for the offline match
   against AutoCount's September GL:
     PV    payment vouchers dated in the window, any status, with lines and ticks
     BILL  purchase invoices + AP invoices dated Aug..Oct (date slips), not cancelled
     JV    manual journals dated in the window, posted or draft, with lines
     RCPT  sundry receipts dated in the window, with lines
     CN    credit / debit notes dated in the window
     SUP   suppliers; ACCT the chart; LETTER the PV letter per bank account
   Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-09-01), TO (2026-09-30). */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = process.env.FROM || '2026-09-01';
const TO = process.env.TO || '2026-09-30';
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sups = await sql`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO}`;
    const supCode = new Map(sups.map((s) => [String(s.id), s.code]));
    for (const s of sups) out('SUP', { id: s.id, code: s.code, name: s.name });
    for (const a of await sql`SELECT account_code, account_name, account_type, parent_code, is_active, section FROM scm.accounts WHERE company_id = ${CO} ORDER BY 1`) out('ACCT', a);

    const pvs = await sql`SELECT * FROM scm.payment_vouchers WHERE company_id = ${CO} AND voucher_date >= ${FROM} AND voucher_date <= ${TO} ORDER BY voucher_date, pv_number`;
    const pvIds = pvs.map((p) => p.id);
    const pvl = pvIds.length ? await sql`SELECT pv_id, line_no, description, debit_account_code, amount_sen FROM scm.payment_voucher_lines WHERE pv_id = ANY(${pvIds}::uuid[]) ORDER BY pv_id, line_no` : [];
    const pva = pvIds.length ? await sql`SELECT a.pv_id, a.amount_sen, a.applied_sen, a.from_advance, coalesce(p.invoice_number, x.invoice_number) AS bill
        FROM scm.pv_allocations a LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id LEFT JOIN scm.ap_invoices x ON x.id = a.ap_invoice_id WHERE a.pv_id = ANY(${pvIds}::uuid[])` : [];
    for (const p of pvs) out('PV', {
      no: p.pv_number, status: String(p.status), date: String(p.voucher_date?.toISOString?.() ?? p.voucher_date).slice(0, 10), payee: p.payee_name, supplier: p.supplier_id ? supCode.get(String(p.supplier_id)) ?? null : null,
      bank: p.credit_account_code, currency: p.currency, rate: Number(p.exchange_rate), total: Number(p.total_sen), purpose: String(p.purpose), notes: p.notes ?? null,
      ref: p.reference_no ?? p.cheque_no ?? p.ref_no ?? null, charge: p.bank_charge_sen ?? null, created: p.created_at,
      lines: pvl.filter((l) => l.pv_id === p.id).map((l) => ({ acct: l.debit_account_code, sen: Number(l.amount_sen), desc: l.description })),
      ticks: pva.filter((a) => a.pv_id === p.id).map((a) => ({ bill: a.bill, planned: Number(a.amount_sen), applied: Number(a.applied_sen), adv: a.from_advance })),
    });

    const pis = await sql`SELECT 'PI' AS k, p.invoice_number AS no, p.supplier_id, p.supplier_invoice_ref AS ref, p.invoice_date::text AS date, p.currency::text AS currency, p.total_sen, p.paid_sen,
        p.status::text AS status, coalesce(p.migrated_no_stock, false) AS migrated, false AS opening, p.linked_ac_docno AS ac, p.created_at
      FROM scm.purchase_invoices p WHERE p.company_id = ${CO} AND p.status::text <> 'CANCELLED' AND p.invoice_date >= '2026-08-01' AND p.invoice_date <= '2026-10-31'
      UNION ALL
      SELECT 'API', a.invoice_number, a.supplier_id, a.supplier_invoice_ref, a.invoice_date::text, a.currency, a.total_sen, a.paid_sen, a.status, false, a.opening, null, a.created_at
      FROM scm.ap_invoices a WHERE a.company_id = ${CO} AND a.status <> 'CANCELLED' AND a.invoice_date >= '2026-08-01' AND a.invoice_date <= '2026-10-31'`;
    const jeOf = new Map((await sql`SELECT source_type || ':' || source_doc_no AS k, entry_date::text AS d FROM scm.journal_entries
        WHERE company_id = ${CO} AND source_type IN ('PI', 'API') AND posted AND NOT reversed AND reversed_by_je IS NULL`).map((r) => [r.k, r.d]));
    for (const b of pis) out('BILL', { k: b.k, no: b.no, supplier: supCode.get(String(b.supplier_id)) ?? null, ref: b.ref, date: b.date, currency: b.currency, total: Number(b.total_sen), paid: Number(b.paid_sen),
      status: b.status, migrated: b.migrated, opening: b.opening, ac: b.ac, je: jeOf.get(`${b.k}:${b.no}`) ?? null, created: b.created_at });

    const jvs = await sql`SELECT id, je_no, entry_date::text AS d, posted, reversed, reversed_by_je, source_type, source_doc_no, narration, total_debit_sen FROM scm.journal_entries
        WHERE company_id = ${CO} AND source_type IN ('MANUAL', 'MANUAL_REVERSAL') AND entry_date >= ${FROM} AND entry_date <= ${TO} ORDER BY entry_date, je_no`;
    const jvl = jvs.length ? await sql`SELECT journal_entry_id, line_no, account_code, debit_sen, credit_sen, notes FROM scm.journal_entry_lines WHERE journal_entry_id = ANY(${jvs.map((j) => j.id)}::uuid[]) ORDER BY journal_entry_id, line_no` : [];
    for (const j of jvs) out('JV', { no: j.je_no, date: j.d, posted: j.posted, reversed: j.reversed, contra: j.reversed_by_je != null, source: j.source_type, doc: j.source_doc_no, narration: j.narration, total: Number(j.total_debit_sen),
      lines: jvl.filter((l) => l.journal_entry_id === j.id).map((l) => ({ acct: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), notes: l.notes })) });

    const rc = await sql`SELECT * FROM scm.acc_receipts WHERE company_id = ${CO} AND receipt_date >= ${FROM} AND receipt_date <= ${TO} ORDER BY receipt_date`;
    const rcl = rc.length ? await sql`SELECT * FROM scm.acc_receipt_lines WHERE receipt_id = ANY(${rc.map((r) => r.id)}::uuid[])` : [];
    for (const r of rc) out('RCPT', { no: r.receipt_number, payer: r.payer_name, date: String(r.receipt_date?.toISOString?.() ?? r.receipt_date).slice(0, 10), bank: r.bank_account_code, total: Number(r.total_sen), status: r.status, notes: r.notes,
      lines: rcl.filter((l) => l.receipt_id === r.id).map((l) => ({ acct: l.credit_account_code ?? l.account_code ?? null, sen: Number(l.amount_sen ?? 0), desc: l.description ?? null })) });

    for (const n of await sql`SELECT note_number, kind, party_code, party_name, note_date::text AS d, total_sen, status, so_doc_no, source_doc_no, opening FROM scm.acc_credit_notes
        WHERE company_id = ${CO} AND note_date >= ${FROM} AND note_date <= ${TO} ORDER BY note_date`) out('CN', n);

    const letters = await sql`SELECT * FROM information_schema.columns WHERE table_schema = 'scm' AND column_name ILIKE '%pv_letter%'`;
    for (const c of letters) {
      const rows = await sql.unsafe(`SELECT * FROM scm.${c.table_name} WHERE ${c.column_name} IS NOT NULL LIMIT 50`);
      for (const r of rows) out('LETTER', { table: c.table_name, column: c.column_name, row: r });
    }
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
