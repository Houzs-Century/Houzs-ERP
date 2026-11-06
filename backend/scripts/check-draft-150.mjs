#!/usr/bin/env node
// check-draft-150.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06: 「如果我把 HC-Draft-2610-150 转去 prepare 会放多一次？先检查」.
// What the voucher pays; what the fair's ledger would read at Prepared, Checked and
// Approved (the same reads and the same journal rule the app uses); and how vouchers
// that already paid a fair's bill behaved on production.
import postgres from 'postgres';
import { d1Compat } from '../src/db/d1-compat.ts';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { pvLines } from '../src/acc/rules.ts';
import { booksLinesFor, readCheckedVoucherLegs, readEventBooks, rowOfLeg, withCheckedVouchers } from '../src/scm/lib/event-books.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (v) => String(v ?? '').slice(0, 10);
const FAIR = 2261;

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const pvs = await tx`SELECT * FROM scm.payment_vouchers WHERE company_id = 1 AND pv_number IN ('HC-Draft-2610-150', 'HC-HPV-2610-025', 'HC-HPV-2610-112') ORDER BY voucher_date, pv_number`;
  for (const p of pvs) {
    const [sup] = p.supplier_id ? await tx`SELECT id, code, name FROM scm.suppliers WHERE id = ${p.supplier_id}` : [null];
    out(`PV ${p.pv_number} | ${p.status} | ${p.purpose} | supplier ${sup?.code ?? '-'} ${sup?.name ?? '-'} | pay from ${p.credit_account_code} | ${rm(p.total_sen)} | bill ${p.bill_ref ?? '-'} ${day(p.bill_date)} | notes ${String(p.notes ?? '').slice(0, 80)}`);
    const allocs = await tx`SELECT * FROM scm.pv_allocations WHERE pv_id = ${p.id}`;
    if (allocs.length === 0) out('   no allocation');
    for (const a of allocs) {
      const inv = a.ap_invoice_id
        ? (await tx`SELECT i.invoice_number, i.status, i.total_sen, i.paid_sen, i.supplier_id, i.invoice_date, s.code, s.name FROM scm.ap_invoices i LEFT JOIN scm.suppliers s ON s.id = i.supplier_id WHERE i.id = ${a.ap_invoice_id}`)[0]
        : (await tx`SELECT i.invoice_number, i.status, i.total_sen, i.paid_sen, i.supplier_id, i.invoice_date, s.code, s.name FROM scm.purchase_invoices i LEFT JOIN scm.suppliers s ON s.id = i.supplier_id WHERE i.id = ${a.pi_id}`)[0];
      out(`   allocation ${rm(a.amount_sen)} applied ${rm(a.applied_sen)} -> ${inv?.invoice_number ?? '?'} ${inv?.status ?? '?'} total ${rm(inv?.total_sen)} paid ${rm(inv?.paid_sen)} owes ${rm(Number(inv?.total_sen ?? 0) - Number(inv?.paid_sen ?? 0))} supplier ${inv?.code ?? '-'} ${inv?.name ?? '-'} dated ${day(inv?.invoice_date)}`);
    }
  }

  /* Every bill and voucher that names this fair. */
  const apis = await tx`
    SELECT i.invoice_number, i.status, i.total_sen, i.paid_sen, s.code, s.name, l.debit_account_code, l.amount_sen, l.description
      FROM scm.ap_invoice_lines l JOIN scm.ap_invoices i ON i.id = l.invoice_id LEFT JOIN scm.suppliers s ON s.id = i.supplier_id
     WHERE l.project_id = ${FAIR} AND l.debit_account_code = '900-R032' ORDER BY i.invoice_number`;
  for (const a of apis) out(`fair ${FAIR} rental bill: ${a.invoice_number} ${a.status} total ${rm(a.total_sen)} paid ${rm(a.paid_sen)} ${a.code ?? '-'} ${a.name ?? '-'} | ${a.debit_account_code} ${rm(a.amount_sen)} | ${String(a.description ?? '').slice(0, 60)}`);
  const pvOnFair = await tx`
    SELECT pv.pv_number, pv.status, pv.checked_at, pv.approved_at, l.debit_account_code, l.amount_sen
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id WHERE l.project_id = ${FAIR} ORDER BY pv.pv_number`;
  for (const v of pvOnFair) out(`fair ${FAIR} voucher line: ${v.pv_number} ${v.status} checked ${!!v.checked_at} approved ${!!v.approved_at} ${v.debit_account_code} ${rm(v.amount_sen)}`);

  /* The fair's page today, and at each stage of the draft. */
  const db = d1Compat(() => tx);
  const [posted, checked] = [await readEventBooks(db, FAIR, 1), await readCheckedVoucherLegs(db, FAIR, 1)];
  if (!posted.ok || !checked.ok) throw new Error(`books: ${posted.reason ?? ''} ${checked.reason ?? ''}`);
  const sumRows = (legs) => {
    const by = {};
    for (const b of booksLinesFor(FAIR, legs)) by[b.category] = Math.round(((by[b.category] ?? 0) + b.amount) * 100) / 100;
    return JSON.stringify(by);
  };
  const today = withCheckedVouchers(posted, checked);
  out(`fair ${FAIR} today: ${sumRows(today.legs)}`);
  const draft = pvs.find((p) => p.pv_number === 'HC-Draft-2610-150');
  if (draft) {
    const lines = await tx`
      SELECT l.description, l.debit_account_code, l.amount_sen, l.project_id, a.account_name, a.account_type, a.pms_row
        FROM scm.payment_voucher_lines l LEFT JOIN scm.accounts a ON a.company_id = l.company_id AND a.account_code = l.debit_account_code
       WHERE l.pv_id = ${draft.id} ORDER BY l.line_no`;
    for (const l of lines) out(`draft line: ${l.debit_account_code} ${l.account_name ?? '-'} type ${l.account_type ?? '-'} pms_row ${l.pms_row ?? '-'} ${rm(l.amount_sen)} project ${l.project_id ?? '-'} | would fill row: ${rowOfLeg(l) ?? 'none'}`);
    out(`at Prepared: the checked read needs checked_at, so it adds nothing. Fair: ${sumRows(today.legs)}`);
    const tagged = lines.filter((l) => l.project_id != null);
    out(`at Checked: the checked read takes this voucher's lines tagged with a fair: ${tagged.length}. Fair: ${sumRows(today.legs)}`);
    const journal = pvLines(draft, lines.map((l) => ({ description: l.description, debit_account_code: l.debit_account_code, myrSen: Number(l.amount_sen), project_id: l.project_id })), { code: null, name: null }, lines[0]?.debit_account_code ?? null);
    for (const j of journal) out(`at Approved, the journal leg: ${j.accountCode} Dr ${rm(j.debitSen)} Cr ${rm(j.creditSen)} fair ${j.projectId ?? '-'}`);
    out(`at Approved: legs tagged with a fair: ${journal.filter((j) => j.projectId != null).length}. Fair: ${sumRows(today.legs)}`);
    const [claimed] = await tx`SELECT count(*)::int AS n FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE pv.status <> 'CANCELLED' AND a.ap_invoice_id IN (SELECT ap_invoice_id FROM scm.pv_allocations WHERE pv_id = ${draft.id} AND ap_invoice_id IS NOT NULL)`;
    out(`live vouchers on that bill, this one included: ${claimed.n}`);
  }

  /* What has already happened on production: supplier payments that paid a bill tagged to a fair. */
  const paid = await tx`
    SELECT DISTINCT pv.company_id, pv.pv_number, pv.status, pv.je_no, i.invoice_number
      FROM scm.pv_allocations a
      JOIN scm.payment_vouchers pv ON pv.id = a.pv_id
      JOIN scm.ap_invoices i ON i.id = a.ap_invoice_id
      JOIN scm.ap_invoice_lines il ON il.invoice_id = i.id AND il.project_id IS NOT NULL
     WHERE pv.status = 'POSTED'`;
  const nos = [...new Set(paid.map((p) => String(p.pv_number)))];
  out(`posted supplier payments that paid a bill tagged to a fair: ${nos.length}`);
  if (nos.length) {
    const legs = await tx`
      SELECT je.source_doc_no, l.account_code, l.project_id, l.debit_sen, l.credit_sen
        FROM scm.journal_entry_lines l JOIN scm.journal_entries je ON je.id = l.journal_entry_id
       WHERE je.source_type = 'PV' AND je.source_doc_no IN ${tx(nos)}`;
    const tagged = legs.filter((l) => l.project_id != null);
    out(`their journal legs: ${legs.length}; tagged with a fair: ${tagged.length}`);
    for (const l of tagged.slice(0, 10)) out(`   tagged: ${l.source_doc_no} ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} fair ${l.project_id}`);
    for (const p of paid.slice(0, 4)) out(`   e.g. ${p.pv_number} paid ${p.invoice_number}`);
  }
  const risky = await tx`
    SELECT pv.pv_number, pv.status, l.debit_account_code, l.amount_sen, l.project_id
      FROM scm.payment_voucher_lines l JOIN scm.payment_vouchers pv ON pv.id = l.pv_id
     WHERE pv.purpose = 'SUPPLIER_PAYMENT' AND l.project_id IS NOT NULL AND pv.status <> 'CANCELLED'`;
  out(`supplier payments with a line tagged to a fair (live): ${risky.length}`);
  for (const r of risky.slice(0, 10)) out(`   ${r.pv_number} ${r.status} ${r.debit_account_code} ${rm(r.amount_sen)} fair ${r.project_id}`);
});
await sql.end();
