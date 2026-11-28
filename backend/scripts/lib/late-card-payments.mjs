// late-card-payments.mjs — the pure part of redate-late-card-payments.mjs:
// which card payments are dated in a later month than the swipe a confirmed
// Merchant Recon line shows, the day each one moves to, the plan's id, and what
// a moved payment must look like when it is read back. No database here
// (tests/lateCardPayments.test.mjs).

import { createHash } from 'node:crypto';

/** The day of a date or timestamp given as text; anything else is no day. */
export const dayOf = (v) => {
  const d = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};
const monthOf = (d) => (d ? d.slice(0, 7) : null);

/** The methods a merchant report line can settle. */
export const CARD_METHODS = new Set(['merchant', 'installment']);

/** The text every audit row this script writes carries, so a later run finds its own work. */
export const AUDIT_TAG = 'redate-late-card-payments';

const byOrderThenId = (a, b) =>
  (a.so_doc_no < b.so_doc_no ? -1 : a.so_doc_no > b.so_doc_no ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The payments to move. `rows` holds one entry per (confirmed Merchant Recon
 * line, payment the line settles):
 *   { id, so_doc_no, so_status, paid_at, method, amount_sen, version, row_id, txn_date }
 * A payment is LATE when one of its lines was swiped in an earlier month than
 * the payment's own day. It moves to the swipe day when that is decidable:
 * all its lines on one day, a card payment, on an order that is not
 * cancelled. Otherwise it is refused, with the reason, and nothing about it is
 * written.
 * Returns { moves, refused }, each sorted by order, then payment id.
 */
export function latePaymentMoves(rows) {
  const byPayment = new Map();
  for (const r of rows) {
    const id = String(r.id);
    const cur = byPayment.get(id) ?? {
      id, so_doc_no: String(r.so_doc_no), so_status: String(r.so_status ?? ''), paid_at: r.paid_at, method: r.method,
      amount_sen: Number(r.amount_sen), version: Number(r.version ?? 1), days: new Set(), row_ids: new Set(),
    };
    cur.days.add(dayOf(r.txn_date) ?? '?');
    cur.row_ids.add(Number(r.row_id));
    byPayment.set(id, cur);
  }
  const moves = [];
  const refused = [];
  for (const p of byPayment.values()) {
    const from = dayOf(p.paid_at);
    const days = [...p.days].sort();
    const late = from != null && days.some((d) => d !== '?' && d < from && monthOf(d) !== monthOf(from));
    if (!late) continue;
    const base = { id: p.id, so_doc_no: p.so_doc_no };
    if (days.length !== 1) { refused.push({ ...base, why: `its confirmed lines are on different days (${days.join(', ')})` }); continue; }
    if (!CARD_METHODS.has(String(p.method))) { refused.push({ ...base, why: `method ${p.method} is not a card payment` }); continue; }
    if (p.so_status === 'CANCELLED') { refused.push({ ...base, why: 'its order is cancelled' }); continue; }
    moves.push({
      ...base, from, to: days[0], amount_sen: p.amount_sen, version: p.version,
      row_ids: [...p.row_ids].sort((a, b) => a - b),
    });
  }
  return { moves: moves.sort(byOrderThenId), refused: refused.sort(byOrderThenId) };
}

/**
 * The payments an earlier run moved whose journal or deposit invoice has not
 * followed yet (a run cut off between the row and its entries). `moved` lists
 * the payments this script's audit rows name, as they stand now:
 *   { id, so_doc_no, paid_at, amount_sen, method, entryDays: [day of each live
 *     SOPAY entry], invoiceDays: [day of each live deposit invoice] }
 * One is due a follow-up when it has no single live entry on its own day, or a
 * live deposit invoice on another day.
 */
export function followUps(moved) {
  const out = [];
  for (const p of moved) {
    const day = dayOf(p.paid_at);
    const entriesRight = p.entryDays.length === 1 && dayOf(p.entryDays[0]) === day;
    const invoicesRight = p.invoiceDays.every((d) => dayOf(d) === day);
    if (!entriesRight || !invoicesRight) {
      out.push({ id: String(p.id), so_doc_no: String(p.so_doc_no), day, amount_sen: Number(p.amount_sen), method: p.method });
    }
  }
  return out.sort(byOrderThenId);
}

/**
 * The plan's id: a hash of exactly what one run would write — each move's
 * payment, order, from and to day, amount and version, and each follow-up —
 * so an apply writes only what its plan showed. Order-independent.
 */
export function planId(moves, follow) {
  const lines = [];
  for (const m of moves) lines.push(`move|${m.id}|${m.so_doc_no}|${m.from}|${m.to}|${m.amount_sen}|${m.version}`);
  for (const f of follow) lines.push(`follow|${f.id}|${f.so_doc_no}|${f.day}|${f.amount_sen}`);
  return createHash('sha256').update(lines.sort().join('\n')).digest('hex').slice(0, 12);
}

/**
 * What one payment must look like, read back after the run. `want` is
 * { id, day, amount_sen, version (or null: not checked), depositFrom (the deposit
 * invoices' start day, or null when they are off), hadInvoice }. `row` is the
 * payment as read; `entries` its SOPAY journals, each { posted, reversed,
 * entry_date, lines: [{ debit_sen, credit_sen }] }; `invoices` its deposit
 * invoices, each { status, invoice_date, amount_sen }.
 * Problems as text; none when it is right.
 */
export function paymentProblems({ want, row, entries, invoices }) {
  const out = [];
  const who = `payment ${want.id}`;
  if (!row) return [`${who}: not found`];
  if (dayOf(row.paid_at) !== want.day) out.push(`${who}: dated ${dayOf(row.paid_at)}, not ${want.day}`);
  if (want.version != null && Number(row.version) !== want.version) out.push(`${who}: version ${row.version}, not ${want.version}`);
  if (Number(row.amount_sen) !== want.amount_sen) out.push(`${who}: amount changed`);

  const live = entries.filter((e) => e.posted === true && e.reversed !== true);
  if (live.length !== 1) out.push(`${who}: ${live.length} live payment entries, not 1`);
  for (const e of live) {
    if (dayOf(e.entry_date) !== want.day) out.push(`${who}: its entry is dated ${dayOf(e.entry_date)}, not ${want.day}`);
    const lines = e.lines ?? [];
    const dr = lines.filter((l) => Number(l.debit_sen) > 0);
    const cr = lines.filter((l) => Number(l.credit_sen) > 0);
    const drSum = dr.reduce((s, l) => s + Number(l.debit_sen), 0);
    const crSum = cr.reduce((s, l) => s + Number(l.credit_sen), 0);
    if (dr.length !== 1 || cr.length !== 1 || drSum !== want.amount_sen || crSum !== want.amount_sen) {
      out.push(`${who}: its entry is not one debit and one credit of the payment's amount`);
    }
  }

  const standing = invoices.filter((d) => String(d.status) !== 'CANCELLED');
  if (standing.length > 1) out.push(`${who}: ${standing.length} live deposit invoices`);
  for (const d of standing) {
    if (dayOf(d.invoice_date) !== want.day) out.push(`${who}: a live deposit invoice dated ${dayOf(d.invoice_date)}, not ${want.day}`);
    if (Number(d.amount_sen) !== want.amount_sen) out.push(`${who}: a live deposit invoice for another amount`);
  }
  const beforeStart = want.depositFrom == null || want.day < want.depositFrom;
  if (beforeStart && standing.length > 0) out.push(`${who}: a live deposit invoice although ${want.day} is before the deposit invoices start`);
  if (!beforeStart && want.hadInvoice && standing.length !== 1) out.push(`${who}: had a deposit invoice and now has ${standing.length}`);
  return out;
}
