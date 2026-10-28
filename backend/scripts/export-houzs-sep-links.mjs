#!/usr/bin/env node
/* export-houzs-sep-links.mjs — READ ONLY. Owner 2026-10-28: 「开始导入9月的资料」.
   AutoCount's September payments knock off bills by AutoCount number; the ERP
   holds those bills as the 31/08 opening papers (notes "AutoCount PI-xxxx")
   or as September bills. This prints what the match needs, one record per
   line (TAG|json):
     OPENAPI   opening AP invoices (number, supplier, ref, date, total, paid, notes)
     OPENSCN   opening supplier credit notes (+ what they already knocked off)
     ALLOC     every voucher tick of the company (voucher + bill), any status
     CNALLOC   every credit-note knock-off of the company
     ADV       supplier advances
     PV        vouchers dated from FROM on, any status, with lines
     PRQ       payment requests raised from FROM on
     SOPAY     sales-order payments FROM..TO whose amount is one of AMOUNTS (sen) or negative
     BILLX     the purchase / AP invoices named in BILLS, whole row + lines
     COLS      columns of the tables an import would write
   Env: DATABASE_URL, COMPANY_ID (1), FROM (2026-08-01), TO (2026-10-31),
   AMOUNTS (comma sen), BILLS (comma numbers). Writes nothing. */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const FROM = process.env.FROM || '2026-08-01';
const TO = process.env.TO || '2026-10-31';
const AMOUNTS = String(process.env.AMOUNTS || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const BILLS = String(process.env.BILLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const out = (tag, o) => console.log(`${tag}|${JSON.stringify(o)}`);
const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d == null ? null : String(d).slice(0, 10));

async function main() {
  if (String(process.env.MODE || 'plan') !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    const sups = await sql`SELECT id, code FROM scm.suppliers WHERE company_id = ${CO}`;
    const supCode = new Map(sups.map((s) => [String(s.id), s.code]));

    for (const a of await sql`SELECT id, invoice_number, supplier_id, supplier_invoice_ref, invoice_date, total_sen, paid_sen, status, notes
        FROM scm.ap_invoices WHERE company_id = ${CO} AND opening ORDER BY invoice_number`) {
      out('OPENAPI', { id: a.id, no: a.invoice_number, supplier: supCode.get(String(a.supplier_id)) ?? null, ref: a.supplier_invoice_ref, date: day(a.invoice_date),
        total: Number(a.total_sen), paid: Number(a.paid_sen), status: a.status, notes: a.notes });
    }
    const scn = await sql`SELECT n.id, n.note_number, n.party_code, n.note_date, n.total_sen, n.status, n.notes, n.opening,
        coalesce((SELECT sum(k.amount_sen) FROM scm.acc_credit_note_allocations k WHERE k.note_id = n.id), 0)::bigint AS knocked
        FROM scm.acc_credit_notes n WHERE n.company_id = ${CO} AND n.kind = 'SCN' AND n.status <> 'CANCELLED' ORDER BY n.note_number`;
    for (const n of scn) out(n.opening ? 'OPENSCN' : 'SCN', { id: n.id, no: n.note_number, supplier: n.party_code, date: day(n.note_date), total: Number(n.total_sen), status: n.status, knocked: Number(n.knocked), notes: n.notes });

    const allocCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'acc_credit_note_allocations'`).map((r) => r.column_name);
    out('COLS', { table: 'acc_credit_note_allocations', cols: allocCols });
    const billCol = allocCols.includes('ap_invoice_id') ? 'ap_invoice_id' : null;
    const piCol = allocCols.includes('pi_id') ? 'pi_id' : allocCols.includes('purchase_invoice_id') ? 'purchase_invoice_id' : null;
    const cnAlloc = await sql.unsafe(`SELECT k.*, n.note_number${billCol ? ', x.invoice_number AS api_no' : ''}${piCol ? ', p.invoice_number AS pi_no' : ''}
        FROM scm.acc_credit_note_allocations k JOIN scm.acc_credit_notes n ON n.id = k.note_id
        ${billCol ? `LEFT JOIN scm.ap_invoices x ON x.id = k.${billCol}` : ''} ${piCol ? `LEFT JOIN scm.purchase_invoices p ON p.id = k.${piCol}` : ''}
        WHERE n.company_id = $1`, [CO]);
    for (const k of cnAlloc) out('CNALLOC', { note: k.note_number, bill: k.api_no ?? k.pi_no ?? null, sen: Number(k.amount_sen), at: k.created_at });

    const pvs = await sql`SELECT * FROM scm.payment_vouchers WHERE company_id = ${CO} AND (voucher_date >= ${FROM} OR status <> 'CANCELLED') ORDER BY voucher_date, pv_number`;
    const pvIds = pvs.map((p) => p.id);
    const pvl = pvIds.length ? await sql`SELECT pv_id, line_no, description, debit_account_code, amount_sen, project_id FROM scm.payment_voucher_lines WHERE pv_id = ANY(${pvIds}::uuid[]) ORDER BY pv_id, line_no` : [];
    const pva = await sql`SELECT a.*, v.pv_number, v.status::text AS pv_status, v.voucher_date, v.total_sen AS pv_total, v.purpose::text AS purpose,
        coalesce(p.invoice_number, x.invoice_number) AS bill, CASE WHEN p.id IS NOT NULL THEN 'PI' ELSE 'API' END AS k, x.opening
        FROM scm.pv_allocations a JOIN scm.payment_vouchers v ON v.id = a.pv_id
        LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id LEFT JOIN scm.ap_invoices x ON x.id = a.ap_invoice_id
        WHERE v.company_id = ${CO}`;
    for (const a of pva) out('ALLOC', { pv: a.pv_number, pvStatus: a.pv_status, pvDate: day(a.voucher_date), purpose: a.purpose, k: a.k, bill: a.bill, opening: a.opening ?? false,
      planned: Number(a.amount_sen), applied: Number(a.applied_sen ?? 0), fromAdvance: a.from_advance ?? false });
    for (const p of pvs.filter((p) => day(p.voucher_date) >= FROM)) out('PV', {
      no: p.pv_number, status: String(p.status), date: day(p.voucher_date), payee: p.payee_name, supplier: p.supplier_id ? supCode.get(String(p.supplier_id)) ?? null : null,
      bank: p.credit_account_code, currency: p.currency, total: Number(p.total_sen), purpose: String(p.purpose), notes: p.notes ?? null, billRef: p.bill_ref ?? null,
      refund: p.refund_source_doc_no ?? null, submitted: p.submitted_at != null, checked: p.checked_at != null, approved: p.approved_at != null, created: p.created_at, createdBy: p.created_by,
      lines: pvl.filter((l) => l.pv_id === p.id).map((l) => ({ acct: l.debit_account_code, sen: Number(l.amount_sen), desc: l.description, event: l.project_id })),
    });
    for (const a of await sql`SELECT a.*, s.code FROM scm.acc_supplier_advances a LEFT JOIN scm.suppliers s ON s.id::text = a.supplier_id::text WHERE a.company_id = ${CO}`) {
      out('ADV', { supplier: a.code, pv: a.pv_number, sen: Number(a.amount_sen), applied: Number(a.applied_sen) });
    }

    for (const r of await sql`SELECT * FROM scm.acc_payment_requests WHERE company_id = ${CO} AND created_at >= ${FROM} ORDER BY created_at`) {
      out('PRQ', Object.fromEntries(Object.entries(r).filter(([k]) => !/file|blob|ocr_json|raw/i.test(k)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
    }

    const payCols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = 'mfg_sales_order_payments' ORDER BY ordinal_position`).map((r) => r.column_name);
    out('COLS', { table: 'mfg_sales_order_payments', cols: payCols });
    const amtCol = payCols.includes('amount_sen') ? 'amount_sen' : payCols.includes('amount_centi') ? 'amount_centi' : null;
    const dateCol = payCols.includes('paid_at') ? 'paid_at' : payCols.includes('payment_date') ? 'payment_date' : 'created_at';
    if (amtCol) {
      const scale = amtCol === 'amount_centi' ? 1 : 1;
      const rows = await sql.unsafe(`SELECT p.* FROM scm.mfg_sales_order_payments p
          WHERE p.company_id = $1 AND p.${dateCol} >= $2 AND p.${dateCol} <= $3 AND (p.${amtCol} < 0 OR abs(p.${amtCol}) = ANY($4::bigint[]))
          ORDER BY p.${dateCol}`, [CO, '2026-08-25', TO, AMOUNTS.map((a) => a * scale)]).catch((e) => { out('ERR', { where: 'sopay', msg: String(e.message) }); return []; });
      for (const r of rows) out('SOPAY', Object.fromEntries(Object.entries(r).filter(([k]) => !/slip|file|ocr|raw|image/i.test(k)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])));
    }

    if (BILLS.length) {
      for (const p of await sql`SELECT * FROM scm.purchase_invoices WHERE company_id = ${CO} AND invoice_number = ANY(${BILLS}::text[])`) {
        const items = await sql`SELECT * FROM scm.purchase_invoice_items WHERE purchase_invoice_id = ${p.id}`;
        out('BILLX', { k: 'PI', row: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])), supplier: supCode.get(String(p.supplier_id)) ?? null,
          items: items.map((i) => ({ item: i.item_code ?? i.material_name, desc: i.description, qty: Number(i.qty), unit: Number(i.unit_price_sen), sen: Number(i.line_total_sen), ac: i.linked_ac_dtlkey != null })) });
      }
      for (const a of await sql`SELECT * FROM scm.ap_invoices WHERE company_id = ${CO} AND invoice_number = ANY(${BILLS}::text[])`) {
        out('BILLX', { k: 'API', row: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v])), supplier: supCode.get(String(a.supplier_id)) ?? null });
      }
    }

    for (const t of ['payment_vouchers', 'payment_voucher_lines', 'pv_allocations', 'ap_invoices', 'ap_invoice_lines', 'acc_receipts', 'acc_receipt_lines', 'journal_entries', 'journal_entry_lines',
      'acc_credit_notes', 'acc_credit_note_lines', 'acc_debtor_bills', 'acc_debtor_bill_lines', 'acc_debtor_receipts', 'acc_debtors', 'acc_payment_requests', 'entity_audit_log', 'doc_number_counters', 'acc_supplier_advances']) {
      const cols = await sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = ${t} ORDER BY ordinal_position`;
      out('COLS', { table: t, cols: cols.map((c) => `${c.column_name}:${c.data_type}${c.is_nullable === 'NO' ? '!' : ''}${c.column_default ? `=${String(c.column_default).slice(0, 40)}` : ''}`) });
    }
    for (const e of await sql`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
        JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'scm' GROUP BY t.typname`) out('ENUM', { type: e.typname, labels: e.labels });
    for (const c of await sql`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE connamespace = 'scm'::regnamespace AND conrelid::regclass::text IN ('scm.payment_vouchers', 'scm.ap_invoices', 'scm.acc_receipts', 'scm.journal_entries', 'scm.acc_credit_notes', 'scm.pv_allocations', 'scm.ap_invoice_lines', 'scm.acc_receipt_lines', 'scm.payment_voucher_lines')
          AND contype IN ('c', 'u')`) out('CONS', c);
    for (const t of await sql`SELECT event_object_table AS tbl, trigger_name, action_timing, event_manipulation FROM information_schema.triggers
        WHERE trigger_schema = 'scm' AND event_object_table IN ('payment_vouchers', 'ap_invoices', 'acc_receipts', 'journal_entries', 'journal_entry_lines', 'pv_allocations', 'acc_credit_notes')`) out('TRIG', t);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
