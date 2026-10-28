#!/usr/bin/env node
// check-so-money-trail — what the books say about the money on one or more
// sales orders: the payment rows (money in, money moved in, money that left),
// the journals those rows booked (SOPAY / SOCONV and their reversals), the
// deposit invoices and credit notes on the order, the receipts, and the card
// clearing balance the company carries. READ-ONLY: SELECT only, no writes, no
// DDL, no transaction.
//
// WHY IT EXISTS. The owner corrected 2990-SO-2608-006 by hand on 2026-09-16
// (a card payment that was really money moved from 2990-SO-2607-024: delete
// the row, add a converted one) and asked to see that every consequence
// landed — the SOPAY reversal, the SOCONV transfer, the credit note on the old
// deposit invoice, the new deposit invoice, the mirror row on the source, the
// clearing account — without a SQL console. This prints the trail, one order
// at a time, and reconciles nothing for the reader.
//
// Run through the production runner (Actions → "Run a backend script on
// production"), mode plan, variables DOCS=2990-SO-2608-006,2990-SO-2607-024.
// Exits 0 for every real answer, including "no such order"; only an
// unreachable database or a failed query exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
const DOCS = (process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (DOCS.length === 0) {
  console.error("DOCS not set — DOCS=2990-SO-2608-006,2990-SO-2607-024. Aborting.");
  process.exit(1);
}

const rm = (sen) => `RM ${(Number(sen ?? 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v) => (v == null ? "—" : String(v).slice(0, 10));
const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  for (const docNo of DOCS) {
    console.log(`\n=== ${docNo} ===`);
    const [so] = await pg`
      SELECT doc_no, status, company_id, debtor_name, local_total_sen, paid_total_sen, balance_sen_live
      FROM scm.mfg_sales_orders_with_payment_totals WHERE doc_no = ${docNo}`;
    if (!so) { notice(`${docNo}: no such order`); continue; }
    console.log(`status ${so.status} · customer ${so.debtor_name} · total ${rm(so.local_total_sen)} · paid (rows summed) ${rm(so.paid_total_sen)} · balance ${rm(so.balance_sen_live)}`);

    const pays = await pg`
      SELECT id, paid_at, method, merchant_provider, amount_sen, account_sheet, note, slip_key, created_at,
             converted_from_so_doc_no, converted_to_so_doc_no, mirror_of_payment_id, refund_pv_id
      FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${docNo}
      ORDER BY paid_at, created_at`;
    console.log(`\npayment rows (${pays.length}):`);
    for (const p of pays) {
      const kind = Number(p.amount_sen) < 0 ? (p.refund_pv_id ? "REFUND MIRROR" : "MOVED OUT") : p.method === "converted" ? "MOVED IN" : "money in";
      const link = p.converted_from_so_doc_no ? ` from ${p.converted_from_so_doc_no}` : p.converted_to_so_doc_no ? ` to ${p.converted_to_so_doc_no}` : p.refund_pv_id ? ` pv ${p.refund_pv_id}` : "";
      console.log(`  ${day(p.paid_at)}  ${kind.padEnd(13)} ${p.method}${p.merchant_provider ? ` (${p.merchant_provider})` : ""}  ${rm(p.amount_sen).padStart(14)}${link}  sheet="${p.account_sheet ?? ""}"  slip=${p.slip_key ? "yes" : "no"}  keyed ${String(p.created_at).slice(0, 16)}  id ${p.id}`);
    }

    const ids = pays.map((p) => String(p.id));
    const jes = ids.length === 0 ? [] : await pg`
      SELECT je_no, entry_date, source_type, source_doc_no, reversed, narration
      FROM scm.journal_entries WHERE company_id = ${so.company_id} AND source_doc_no IN ${pg(ids)}
      ORDER BY entry_date, je_no`;
    /* The reversals name the entry they void, not the payment: fetch them by the je they reverse. */
    const jeNos = jes.map((j) => j.je_no);
    const reversals = jeNos.length === 0 ? [] : await pg`
      SELECT je_no, entry_date, source_type, source_doc_no, narration
      FROM scm.journal_entries WHERE company_id = ${so.company_id} AND source_type LIKE '%_REVERSAL' AND narration LIKE ANY(${jeNos.map((n) => `%${n}%`)})
      ORDER BY entry_date, je_no`;
    console.log(`\njournals booked by those rows (${jes.length}) + their reversals (${reversals.length}):`);
    for (const j of [...jes, ...reversals]) {
      const lines = await pg`
        SELECT account_code, debit_sen, credit_sen, party_code FROM scm.journal_entry_lines
        WHERE journal_entry_id = (SELECT id FROM scm.journal_entries WHERE je_no = ${j.je_no} AND company_id = ${so.company_id} LIMIT 1)
        ORDER BY line_no`;
      const legs = lines.map((l) => `${l.account_code}${l.party_code ? `/${l.party_code}` : ""} ${Number(l.debit_sen) > 0 ? `Dr ${rm(l.debit_sen)}` : `Cr ${rm(l.credit_sen)}`}`).join(" | ");
      console.log(`  ${day(j.entry_date)}  ${j.je_no}  ${String(j.source_type).padEnd(15)} ${j.reversed ? "(reversed) " : ""}${j.narration ?? ""}\n      ${legs}`);
    }

    /* A DELETED row's booking and its reversal name the order in their narration, not a row that still exists. */
    const named = await pg`
      SELECT je_no, entry_date, source_type, source_doc_no, reversed, narration
      FROM scm.journal_entries WHERE company_id = ${so.company_id} AND narration LIKE ${'%' + docNo + '%'}
        AND source_doc_no <> ALL(${ids.length ? ids : ['-']}) AND NOT (narration LIKE ANY(${jeNos.length ? jeNos.map((n) => `%${n}%`) : ['-']}))
      ORDER BY entry_date, je_no`;
    console.log(`
other journals naming the order — rows since deleted, and their reversals (${named.length}):`);
    for (const j of named) {
      const lines = await pg`
        SELECT account_code, debit_sen, credit_sen, party_code FROM scm.journal_entry_lines
        WHERE journal_entry_id = (SELECT id FROM scm.journal_entries WHERE je_no = ${j.je_no} AND company_id = ${so.company_id} LIMIT 1)
        ORDER BY line_no`;
      const legs = lines.map((l) => `${l.account_code}${l.party_code ? `/${l.party_code}` : ''} ${Number(l.debit_sen) > 0 ? `Dr ${rm(l.debit_sen)}` : `Cr ${rm(l.credit_sen)}`}`).join(' | ');
      console.log(`  ${day(j.entry_date)}  ${j.je_no}  ${String(j.source_type).padEnd(15)} ${j.reversed ? '(reversed) ' : ''}${j.narration ?? ''}
      ${legs}`);
    }

    const dis = await pg`
      SELECT di_number, invoice_date, amount_sen, status, payment_id, credit_note_id
      FROM scm.acc_deposit_invoices WHERE company_id = ${so.company_id} AND so_doc_no = ${docNo} ORDER BY invoice_date, di_number`;
    console.log(`\ndeposit invoices (${dis.length}):`);
    for (const d of dis) console.log(`  ${day(d.invoice_date)}  ${d.di_number}  ${rm(d.amount_sen).padStart(14)}  ${d.status}  payment ${d.payment_id}${d.credit_note_id ? "  closed by note" : ""}`);

    const cns = await pg`
      SELECT note_number, note_date, total_sen, status, source_doc_no, refund_pv_id, converted_payment_id, reason
      FROM scm.acc_credit_notes WHERE company_id = ${so.company_id} AND so_doc_no = ${docNo} ORDER BY note_date, note_number`;
    console.log(`\ncredit notes on the order (${cns.length}):`);
    for (const n of cns) console.log(`  ${day(n.note_date)}  ${n.note_number}  ${rm(n.total_sen).padStart(14)}  ${n.status}  against ${n.source_doc_no}  ${n.converted_payment_id ? `for converted row ${n.converted_payment_id}` : n.refund_pv_id ? `for refund pv ${n.refund_pv_id}` : ""}  ${n.reason ?? ""}`);

    const ors = ids.length === 0 ? [] : await pg`
      SELECT or_number, status, paid_at, amount_sen, payment_id FROM scm.acc_official_receipts
      WHERE company_id = ${so.company_id} AND payment_source = 'SOPAY' AND payment_id IN ${pg(ids)} ORDER BY or_number`;
    const orphanOrs = await pg`
      SELECT or_number, status, paid_at, amount_sen, payment_id FROM scm.acc_official_receipts
      WHERE company_id = ${so.company_id} AND doc_no = ${docNo} AND payment_source = 'SOPAY'
        AND payment_id NOT IN (SELECT id::text FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${docNo}) ORDER BY or_number`;
    console.log(`\nreceipts for those rows (${ors.length})${orphanOrs.length ? ` + ORPHANS whose payment is gone (${orphanOrs.length})` : ""}:`);
    for (const r of ors) console.log(`  ${r.or_number}  ${r.status}  ${day(r.paid_at)}  ${rm(r.amount_sen)}  payment ${r.payment_id}`);
    for (const r of orphanOrs) console.log(`  ORPHAN ${r.or_number}  ${r.status}  ${day(r.paid_at)}  ${rm(r.amount_sen)}  payment ${r.payment_id} (deleted)`);

    const [clearing] = await pg`
      SELECT COALESCE(SUM(debit_sen) - SUM(credit_sen), 0) AS bal FROM scm.v_gl_entries
      WHERE company_id = ${so.company_id} AND account_code = '326-0000'`;
    notice(`${docNo}: ${pays.length} payment rows, paid ${rm(so.paid_total_sen)}, balance ${rm(so.balance_sen_live)}; company card clearing 326-0000 now ${rm(clearing?.bal)}`);
  }
} finally {
  await pg.end();
}
