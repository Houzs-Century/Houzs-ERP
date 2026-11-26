// deposit-invoice-backlog.mjs — the pure part of issue-missing-deposit-invoices.mjs:
// which payments one run issues, the plan's id, and what an issued deposit
// invoice must look like when it is read back. No database here
// (tests/depositInvoiceBacklog.test.mjs).

import { createHash } from 'node:crypto';

/** The day of a date or timestamp given as text; anything else is no day. */
export const dayOf = (v) => {
  const d = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

/**
 * One run's share of the backlog, month by month (the payment day's month,
 * ascending). Within a month: payment day, then id — the order
 * issueMissingDepositInvoices issues in, so each month's numbers follow the
 * money. `months` (a set of YYYY-MM, or null for all) keeps only those months;
 * `maxPerMonth` (a whole number, or null for no cap) takes each month's first
 * ones, the rest left for a later run, which carries on in the same order.
 */
export function batchByMonth(payments, { months, maxPerMonth }) {
  const byMonth = new Map();
  for (const p of payments) {
    const day = dayOf(p.paid_at);
    if (!day) continue;
    const month = day.slice(0, 7);
    if (months && !months.has(month)) continue;
    const list = byMonth.get(month) ?? [];
    list.push({ ...p, day });
    byMonth.set(month, list);
  }
  const out = new Map();
  for (const month of [...byMonth.keys()].sort()) {
    const list = byMonth.get(month).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    out.set(month, maxPerMonth == null ? list : list.slice(0, maxPerMonth));
  }
  return out;
}

/**
 * The plan's id: a hash of exactly what one run would write — each payment's
 * id, order, day and amount, and each unposted invoice to post — so an apply
 * writes only what its plan showed. Order-independent.
 */
export function planId(batches, unposted) {
  const lines = [];
  for (const [month, list] of batches) for (const p of list) lines.push(`issue|${month}|${p.id}|${p.so_doc_no}|${p.day}|${Number(p.amount_sen)}`);
  for (const d of unposted) lines.push(`post|${d.id}|${d.di_number}|${Number(d.amount_sen)}`);
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 12);
}

/**
 * What one payment's deposit invoice must look like, read back: one live
 * invoice on that payment and order, for its amount, dated its day, numbered
 * in that day's month, with a journal; the journal posted and standing,
 * source DI / the invoice's number, dated the invoice day, exactly two lines —
 * Dr AR with the invoice's party for the amount, Cr DEPOSIT_INCOME for the
 * amount. Problems as text; none when it is right.
 */
export function depositInvoiceProblems({ payment, invoices, entries, lines, roles }) {
  const who = `payment ${payment.id} (${payment.so_doc_no}, ${payment.day})`;
  const mine = invoices.filter((d) => String(d.payment_id) === String(payment.id) && d.status !== 'CANCELLED');
  if (mine.length !== 1) return [`${who}: ${mine.length} live deposit invoices, expected one`];
  const d = mine[0];
  const out = [];
  const amount = Number(payment.amount_sen);
  if (d.payment_source !== 'SOPAY') out.push(`${who}: ${d.di_number} is not on a sales order payment`);
  if (d.so_doc_no !== payment.so_doc_no) out.push(`${who}: ${d.di_number} is on ${d.so_doc_no}`);
  if (Number(d.amount_sen) !== amount) out.push(`${who}: ${d.di_number} is not the payment's amount`);
  if (dayOf(d.invoice_date) !== payment.day) out.push(`${who}: ${d.di_number} is dated ${dayOf(d.invoice_date)}, not the payment's day`);
  const tag = `${payment.day.slice(2, 4)}${payment.day.slice(5, 7)}`;
  if (!new RegExp(`DI-${tag}-\\d{3,}$`).test(String(d.di_number ?? ''))) out.push(`${who}: ${d.di_number} is not numbered in its month (DI-${tag}-…)`);
  if (d.status !== 'ISSUED') out.push(`${who}: ${d.di_number} is ${d.status}`);
  if (!d.je_no) return [...out, `${who}: ${d.di_number} has no journal`];
  const je = entries.filter((e) => e.je_no === d.je_no);
  if (je.length !== 1) return [...out, `${who}: ${d.di_number}'s journal ${d.je_no} reads back ${je.length} times`];
  const e = je[0];
  if (e.posted !== true || e.reversed === true) out.push(`${who}: ${d.je_no} is not a posted, standing entry`);
  if (e.source_type !== 'DI' || e.source_doc_no !== d.di_number) out.push(`${who}: ${d.je_no} is not the entry of ${d.di_number}`);
  if (dayOf(e.entry_date) !== payment.day) out.push(`${who}: ${d.je_no} is dated ${dayOf(e.entry_date)}, not the invoice day`);
  const ls = lines.filter((l) => String(l.journal_entry_id) === String(e.id));
  const dr = ls.filter((l) => l.account_code === roles.AR && Number(l.debit_sen) === amount && Number(l.credit_sen) === 0
    && (l.party_code ?? null) === (d.party_code ?? null));
  const cr = ls.filter((l) => l.account_code === roles.DEPOSIT_INCOME && Number(l.credit_sen) === amount && Number(l.debit_sen) === 0);
  if (ls.length !== 2 || dr.length !== 1 || cr.length !== 1) {
    out.push(`${who}: ${d.je_no} is not two lines, Dr ${roles.AR} (the invoice's party) / Cr ${roles.DEPOSIT_INCOME}, for the payment's amount`);
  }
  return out;
}
