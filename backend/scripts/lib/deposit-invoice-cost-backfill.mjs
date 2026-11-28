// deposit-invoice-cost-backfill.mjs — the pure part of
// backfill-deposit-invoice-cost.mjs: the cost one invoice books, the plan's
// id, and what an invoice posted again with its cost must look like read back.
// No database here (tests/depositInvoiceCostBackfill.test.mjs).

import { createHash } from 'node:crypto';

const day = (v) => String(v ?? '').slice(0, 10);

/** A deposit's cost at that share, whole sen — acc/deposit-cost.ts depositCostSen's rounding. */
export const costOf = (amountSen, pct) => Math.round((Number(amountSen) * pct) / 100);

/** The plan's id: the share and every invoice to post again, by number, amount and current entry. Order-independent. */
export function planId(pct, invoices) {
  const lines = invoices.map((d) => `${d.di_number}|${Number(d.amount_sen)}|${d.je_no ?? ''}`).sort();
  return createHash('sha256').update(`${pct}\n${lines.join('\n')}`).digest('hex').slice(0, 12);
}

/**
 * What one invoice posted again must look like: it names the new entry and
 * records its cost; the new entry is the invoice's only standing DI entry,
 * posted on the invoice day, four lines — Dr AR with the invoice's party and
 * Cr DEPOSIT_INCOME for the deposit, Dr DEPOSIT_COST and Cr
 * DEPOSIT_COST_ACCRUAL for its cost; the old entry is reversed by a posted
 * contra on its own day. Problems as text; none when it is right.
 */
export function repostProblems({ di, oldJeNo, entries, lines, roles, pct }) {
  const who = di.di_number;
  const out = [];
  const amount = Number(di.amount_sen);
  const cost = costOf(amount, pct);
  if (Number(di.cost_sen) !== cost) out.push(`${who}: records a cost of ${di.cost_sen} sen, not ${cost}`);
  const mine = entries.filter((e) => e.source_doc_no === who);
  const live = mine.filter((e) => e.source_type === 'DI' && e.reversed !== true);
  if (live.length !== 1) return [...out, `${who}: ${live.length} standing DI entries, expected one`];
  const e = live[0];
  if (e.je_no !== di.je_no) out.push(`${who}: names ${di.je_no}, but its standing entry is ${e.je_no}`);
  if (e.posted !== true) out.push(`${who}: ${e.je_no} is not posted`);
  if (day(e.entry_date) !== day(di.invoice_date)) out.push(`${who}: ${e.je_no} is dated ${day(e.entry_date)}, not the invoice day`);
  if (oldJeNo && oldJeNo !== e.je_no) {
    const old = mine.find((x) => x.je_no === oldJeNo);
    const contra = old ? mine.find((x) => x.source_type === 'DI_REVERSAL' && String(x.reversed_by_je) === String(old.id)) : null;
    if (!old || old.reversed !== true) out.push(`${who}: the old entry ${oldJeNo} is not reversed`);
    else if (!contra || contra.posted !== true || day(contra.entry_date) !== day(old.entry_date)) out.push(`${who}: the old entry ${oldJeNo} has no posted contra on its own day`);
  }
  const ls = lines.filter((l) => String(l.journal_entry_id) === String(e.id));
  const one = (code, dr, cr, party) => ls.filter((l) => l.account_code === code && Number(l.debit_sen) === dr && Number(l.credit_sen) === cr
    && (party === undefined || (l.party_code ?? null) === party)).length === 1;
  const shaped = ls.length === 4
    && one(roles.AR, amount, 0, di.party_code ?? null) && one(roles.DEPOSIT_INCOME, 0, amount)
    && one(roles.DEPOSIT_COST, cost, 0) && one(roles.DEPOSIT_COST_ACCRUAL, 0, cost);
  if (!shaped) out.push(`${who}: ${e.je_no} is not Dr ${roles.AR} (the invoice's party) / Cr ${roles.DEPOSIT_INCOME} for the deposit and Dr ${roles.DEPOSIT_COST} / Cr ${roles.DEPOSIT_COST_ACCRUAL} for ${pct}% of it`);
  return out;
}
