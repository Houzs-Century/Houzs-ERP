#!/usr/bin/env node
// check-cancelled-vouchers.mjs: READ ONLY, one READ ONLY transaction, writes nothing.
// Owner 2026-11-06: 「所以 cancel 了重新开不会有问题对吗？」. Every cancelled voucher in both
// companies: does anything of it still count in the books, on a bill, on a bank line, on
// a fair or on Money today?
import postgres from 'postgres';
import { pgSslMode } from './lib/pg-ssl-mode.mjs';
import { countsInTheBooks } from '../src/acc/reversal-pairs.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(2); }
if (process.env.APPLY === '1') { console.error('Read only.'); process.exit(1); }
const asText = (oid) => ({ to: oid, from: [oid], serialize: (x) => x, parse: (x) => x });
const sql = postgres(url, { ssl: pgSslMode(url), max: 1, prepare: false, types: { dateText: asText(1082), tsText: asText(1114), tstzText: asText(1184) } });
const out = (s) => console.log(`ROW|${s}`);
const rm = (sen) => (Number(sen ?? 0) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

await sql.begin('READ ONLY', async (tx) => {
  await tx`SET LOCAL search_path = public, scm`;
  const cancelled = await tx`SELECT id, company_id, pv_number, total_sen, submitted_at, checked_at, approved_at FROM scm.payment_vouchers WHERE status = 'CANCELLED'`;
  const byCo = {};
  for (const p of cancelled) {
    const b = byCo[p.company_id] ?? (byCo[p.company_id] = { n: 0, sen: 0, checked: 0, approved: 0 });
    b.n += 1; b.sen += Number(p.total_sen ?? 0);
    if (p.checked_at) b.checked += 1;
    if (p.approved_at) b.approved += 1;
  }
  out(`cancelled vouchers: ${JSON.stringify(byCo)}`);
  const numbers = cancelled.map((p) => String(p.pv_number));
  const ids = cancelled.map((p) => p.id);

  /* The books. */
  const legs = numbers.length ? await tx`
    SELECT je_no, entry_date, source_type, source_doc_no, account_code, debit_sen, credit_sen, posted, reversed, reversed_by_je
      FROM scm.v_gl_entries WHERE source_doc_no IN ${tx(numbers)} AND source_type IN ('PV', 'PV_REVERSAL')` : [];
  const counting = legs.filter(countsInTheBooks);
  out(`their journal legs: ${legs.length}; still counting in the books: ${counting.length}`);
  for (const l of counting.slice(0, 12)) out(`   ${l.je_no} ${l.source_type} ${l.source_doc_no} ${l.account_code} Dr ${rm(l.debit_sen)} Cr ${rm(l.credit_sen)} reversed ${l.reversed} by ${l.reversed_by_je ?? '-'}`);
  const raw = numbers.length ? await tx`
    SELECT je.je_no, je.source_type, je.source_doc_no, je.posted, je.reversed, je.reversed_by_je::text AS by
      FROM scm.journal_entries je WHERE je.source_doc_no IN ${tx(numbers)} AND je.source_type IN ('PV', 'PV_REVERSAL')` : [];
  const dangling = raw.filter((j) => j.posted === false || (j.source_type === 'PV' && !j.reversed));
  out(`their journals: ${raw.length}; not posted, or an original not reversed: ${dangling.length}`);
  for (const j of dangling.slice(0, 12)) out(`   ${j.je_no} ${j.source_type} ${j.source_doc_no} posted ${j.posted} reversed ${j.reversed} by ${j.by ?? '-'}`);

  /* The bills. */
  const allocs = ids.length ? await tx`SELECT pv_id, pi_id, ap_invoice_id, amount_sen, applied_sen FROM scm.pv_allocations WHERE pv_id IN ${tx(ids)}` : [];
  const applied = allocs.filter((a) => Number(a.applied_sen ?? 0) > 0);
  out(`their bill allocations: ${allocs.length}; still applied to a bill: ${applied.length} (${rm(applied.reduce((s, a) => s + Number(a.applied_sen), 0))})`);
  const apIds = [...new Set(allocs.map((a) => a.ap_invoice_id).filter(Boolean))];
  const piIds = [...new Set(allocs.map((a) => a.pi_id).filter(Boolean))];
  const apRows = apIds.length ? await tx`SELECT id, invoice_number, status, total_sen, paid_sen FROM scm.ap_invoices WHERE id IN ${tx(apIds)}` : [];
  const piRows = piIds.length ? await tx`SELECT id, invoice_number, status, total_sen, paid_sen FROM scm.purchase_invoices WHERE id IN ${tx(piIds)}` : [];
  const liveAp = apIds.length ? await tx`SELECT a.ap_invoice_id AS id, sum(a.applied_sen)::bigint AS s FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE a.ap_invoice_id IN ${tx(apIds)} AND pv.status <> 'CANCELLED' GROUP BY 1` : [];
  const livePi = piIds.length ? await tx`SELECT a.pi_id AS id, sum(a.applied_sen)::bigint AS s FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id WHERE a.pi_id IN ${tx(piIds)} AND pv.status <> 'CANCELLED' GROUP BY 1` : [];
  const liveOf = new Map([...liveAp, ...livePi].map((x) => [String(x.id), Number(x.s ?? 0)]));
  const bills = [...apRows, ...piRows];
  const off = bills.filter((b) => Number(b.paid_sen ?? 0) !== (liveOf.get(String(b.id)) ?? 0));
  out(`bills those vouchers had named: ${bills.length}; paid figure different from the live vouchers' applied: ${off.length}`);
  for (const b of off.slice(0, 12)) out(`   ${b.invoice_number} ${b.status} total ${rm(b.total_sen)} paid ${rm(b.paid_sen)} live vouchers ${rm(liveOf.get(String(b.id)) ?? 0)} (a credit note or advance can explain a difference)`);

  /* The bank. */
  const jeNos = [...new Set(legs.map((l) => String(l.je_no)))];
  const claimed = jeNos.length ? await tx`
    SELECT m.je_no, l.state, l.booked_on, l.amount_sen FROM scm.acc_bank_statement_matches m JOIN scm.acc_bank_statement_lines l ON l.id = m.bank_line_id WHERE m.je_no IN ${tx(jeNos)}` : [];
  out(`bank lines matched to their journals: ${claimed.length}`);
  for (const c of claimed.slice(0, 10)) out(`   ${c.je_no} ${c.state} ${String(c.booked_on).slice(0, 10)} ${rm(c.amount_sen)}`);

  /* The fairs. */
  const tagged = legs.length ? counting.length : 0;
  out(`fair: legs of cancelled vouchers that still count: ${tagged} (a fair reads only counting legs and live checked vouchers)`);

  /* Payment requests left behind. */
  const reqs = await tx`
    SELECT r.company_id, r.request_no, r.status, r.amount_sen, pv.pv_number, r.refund_source_doc_no
      FROM scm.acc_payment_requests r JOIN scm.payment_vouchers pv ON pv.id = r.pv_id WHERE pv.status = 'CANCELLED'`;
  out(`payment requests whose voucher was cancelled: ${reqs.length}`);
  for (const r of reqs.slice(0, 14)) out(`   ${r.request_no} ${r.status} ${rm(r.amount_sen)} was ${r.pv_number}${r.refund_source_doc_no ? ` refund on ${r.refund_source_doc_no}` : ''}`);

  /* Reopened: the live voucher that replaced a cancelled one on the same bill. */
  const reopened = await tx`
    SELECT i.invoice_number, count(*) FILTER (WHERE pv.status = 'CANCELLED')::int AS cancelled, count(*) FILTER (WHERE pv.status <> 'CANCELLED')::int AS live,
           sum(a.amount_sen) FILTER (WHERE pv.status <> 'CANCELLED')::bigint AS live_sen, max(i.total_sen)::bigint AS total, max(i.paid_sen)::bigint AS paid
      FROM scm.pv_allocations a JOIN scm.payment_vouchers pv ON pv.id = a.pv_id JOIN scm.ap_invoices i ON i.id = a.ap_invoice_id
     GROUP BY 1 HAVING count(*) FILTER (WHERE pv.status = 'CANCELLED') > 0 AND count(*) FILTER (WHERE pv.status <> 'CANCELLED') > 0`;
  const over = reopened.filter((r) => Number(r.live_sen) > Number(r.total));
  out(`AP invoices cancelled once and re-paid by a live voucher: ${reopened.length}; live vouchers asking more than the bill: ${over.length}`);
  for (const r of over.slice(0, 10)) out(`   ${r.invoice_number} live ${rm(r.live_sen)} of ${rm(r.total)} (${r.live} live)`);
});
await sql.end();
