#!/usr/bin/env node
/* check-houzs-opening-loose-ends.mjs — READ ONLY. What the books-start trial
   (open-houzs-books-start.mjs, plan) left to look at before the owner confirms:
     1. Dunlopillo HC-API-2606-001 (the trial found it not on file) — every row
        under that number, its ticks, and every Dunlopillo voucher since 01/09
        with its ticks, journal and advance;
     2. the Diglant drafts that tick ERP-only August bills (HC-PI-2609-023 /
        -024) — the drafts' every tick and total;
     3. card / online money: the soft-launch SOPAY lines on 326-0000 / 327-0000
        dated before 01/09 and what settled them, by settlement date.
   Writes nothing. Env: DATABASE_URL, COMPANY_ID (1). */
import postgres from 'postgres';

const CO = Number(process.env.COMPANY_ID || 1);
const MODE = String(process.env.MODE || 'plan');
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const out = (s) => console.log(`ROW|${s}`);

async function main() {
  if (MODE !== 'plan') { console.error('read-only: MODE must be plan'); process.exit(2); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    /* 1. Dunlopillo */
    const api = await sql`SELECT a.id, a.invoice_number, a.status, a.total_sen, a.paid_sen, a.invoice_date::text AS d, a.cancelled_at, a.cancelled_by, a.updated_at, s.code
        FROM scm.ap_invoices a LEFT JOIN scm.suppliers s ON s.id = a.supplier_id WHERE a.company_id = ${CO} AND a.invoice_number LIKE 'HC-API-2606-00%' ORDER BY 2`;
    for (const r of api) out(`API ${r.invoice_number} ${r.code} ${r.status} total ${rm(r.total_sen)} paid ${rm(r.paid_sen)} dated ${r.d} cancelled ${r.cancelled_at?.toISOString?.() ?? r.cancelled_at ?? '-'} by ${r.cancelled_by ?? '-'} updated ${r.updated_at?.toISOString?.() ?? r.updated_at}`);
    const dun = await sql`SELECT id, code, name FROM scm.suppliers WHERE company_id = ${CO} AND (code = '400-D001' OR name ILIKE '%dunlopillo%')`;
    for (const s of dun) out(`supplier ${s.code} ${s.name} ${s.id}`);
    const pvs = await sql`SELECT v.id, v.pv_number, v.status::text AS status, v.voucher_date::text AS d, v.total_sen, v.purpose::text AS purpose, v.notes
        FROM scm.payment_vouchers v WHERE v.company_id = ${CO} AND v.supplier_id = ANY(${dun.map((s) => s.id)}::uuid[]) AND v.voucher_date >= '2026-06-01' ORDER BY v.voucher_date, v.pv_number`;
    for (const v of pvs) {
      const al = await sql`SELECT a.amount_sen, a.applied_sen, a.from_advance, coalesce(p.invoice_number, x.invoice_number) AS bill
          FROM scm.pv_allocations a LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id LEFT JOIN scm.ap_invoices x ON x.id = a.ap_invoice_id WHERE a.pv_id = ${v.id}`;
      const adv = await sql`SELECT amount_sen, applied_sen FROM scm.acc_supplier_advances WHERE pv_id = ${String(v.id)}`;
      const je = await sql`SELECT je_no, entry_date::text AS d, reversed, total_debit_sen FROM scm.journal_entries WHERE company_id = ${CO} AND source_type = 'PV' AND source_doc_no = ${v.pv_number}`;
      out(`PV ${v.pv_number} ${v.status} ${v.d} ${rm(v.total_sen)} ${v.purpose} — ticks ${al.map((a) => `${a.bill} ${rm(a.amount_sen)}/${rm(a.applied_sen)}${a.from_advance ? ' (advance)' : ''}`).join('; ') || 'none'} — advance ${adv.map((a) => `${rm(a.amount_sen)} applied ${rm(a.applied_sen)}`).join('; ') || 'none'} — journal ${je.map((j) => `${j.je_no} ${j.d}${j.reversed ? ' reversed' : ''} ${rm(j.total_debit_sen)}`).join('; ') || 'none'} — ${String(v.notes ?? '').slice(0, 80)}`);
    }
    const audit = await sql`SELECT entity_doc_no, action, actor_name_snapshot, note, created_at FROM scm.entity_audit_log
        WHERE company_id = ${CO} AND entity_doc_no IN ('HC-API-2606-001') ORDER BY created_at`;
    for (const a of audit) out(`audit ${a.entity_doc_no} ${a.action} ${a.actor_name_snapshot} ${a.created_at?.toISOString?.() ?? a.created_at} ${String(a.note ?? '').slice(0, 160)}`);

    /* 2. The Diglant drafts */
    for (const no of ['HC-Draft-2610-102', 'HC-Draft-2610-103', 'HC-Draft-2610-104']) {
      const v = await sql`SELECT id, pv_number, status::text AS status, voucher_date::text AS d, total_sen, notes FROM scm.payment_vouchers WHERE company_id = ${CO} AND pv_number = ${no}`;
      if (!v.length) { out(`draft ${no}: not found`); continue; }
      const al = await sql`SELECT a.amount_sen, coalesce(p.invoice_number, x.invoice_number) AS bill, coalesce(p.supplier_invoice_ref, x.supplier_invoice_ref) AS ref
          FROM scm.pv_allocations a LEFT JOIN scm.purchase_invoices p ON p.id = a.pi_id LEFT JOIN scm.ap_invoices x ON x.id = a.ap_invoice_id WHERE a.pv_id = ${v[0].id}`;
      out(`draft ${no} ${v[0].status} ${v[0].d} total ${rm(v[0].total_sen)} — ${al.map((a) => `${a.bill} (${a.ref ?? '-'}) ${rm(a.amount_sen)}`).join('; ')} — ${String(v[0].notes ?? '').slice(0, 100)}`);
    }

    /* 3. Card / online money across the cutover */
    const soft = await sql`SELECT l.account_code AS code, j.source_type AS src, count(*)::int AS n, sum(l.debit_sen - l.credit_sen)::bigint AS net
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date < '2026-09-01' AND l.account_code IN ('326-0000', '327-0000')
        GROUP BY 1, 2 ORDER BY 1, 2`;
    for (const r of soft) out(`soft-launch ${r.code} ${r.src} ×${r.n} net ${rm(r.net)}`);
    const sepSettle = await sql`SELECT l.account_code AS code, j.source_type AS src, count(*)::int AS n, sum(l.debit_sen - l.credit_sen)::bigint AS net
        FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        WHERE j.company_id = ${CO} AND j.posted AND NOT j.reversed AND j.reversed_by_je IS NULL AND j.entry_date >= '2026-09-01' AND j.entry_date <= '2026-10-31' AND l.account_code IN ('326-0000', '327-0000')
        GROUP BY 1, 2 ORDER BY 1, 2`;
    for (const r of sepSettle) out(`from 01/09 to 31/10 ${r.code} ${r.src} ×${r.n} net ${rm(r.net)}`);
    /* The payments the soft launch booked onto transit: which were settled from 01/09, and how much. */
    const pays = await sql`SELECT p.id, p.paid_at::date::text AS d, p.amount_sen, p.method, p.so_doc_no
        FROM scm.mfg_sales_order_payments p
        WHERE p.company_id = ${CO} AND p.paid_at < '2026-09-01' AND p.method IN ('MERCHANT', 'INSTALLMENT', 'ONLINE') AND p.converted_from_so_doc_no IS NULL`;
    out(`card / online payments dated before 01/09 in the ERP: ${pays.length} RM ${rm(pays.reduce((s, p) => s + Number(p.amount_sen), 0))} (${[...new Set(pays.map((p) => p.method))].join(', ')})`);
  } finally {
    await sql.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
