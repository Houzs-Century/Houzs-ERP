/* Make an edited payment carry its journal entry with it.

   `PATCH /:docNo/payments/:id` has never touched the ledger: it writes the
   row, recomputes what the invoices off that order have settled, queues an
   AutoCount edit, and stops. docs/bugs/0774 made the resulting divergence
   VISIBLE on Self-check; this file stops it happening, by the pattern general
   receipts already use — reverse the old entry, book a fresh one.

   It exists as its own module rather than inside the route because the route
   is 11,000 lines of sales-order handling and this is an accounting decision:
   which edits move the books, and where the correcting contra is dated. Both
   answers belong beside the poster that made the original entry. */

import { reverseJournal } from './engine';
import { postSoPayment, type PostPaymentResult, type SoPaymentRow } from './payments';

type Db = Parameters<typeof postSoPayment>[0];

/** The FOUR fields of a payment that reach the ledger, and nothing else:
    - `amount`   — the figure on both lines
    - `date`     — the entry date, which decides the period
    - `method`   — picks the debit account (cash / bank / EDC transit)
    - `acquirer` — picks WHICH transit account a card payment lands in

    An approval code, an account sheet, a collector, an installment term, an
    online sub-type: none of them change a single line, and re-posting for one
    of those would churn the ledger and spend a JE number to write the same
    entry back. */
export type LedgerField = 'amount' | 'date' | 'method' | 'acquirer';

export type PaymentLedgerFacts = {
  amountSen: number;
  paidOn: string;
  method: string;
  merchantProvider: string | null;
};

export type RepostResult =
  | { ok: true; status: 'unchanged'; moved: LedgerField[] }
  /** `originalJeNo` is the entry that was voided and `contraJeNo` the contra
      that voided it — both null when the payment had never booked, so there
      was nothing to reverse. The original's number is the one a reader
      recognises; the contra's alone was read as "the entry that was reversed"
      (docs/bugs/0786). */
  | { ok: true; status: 'reposted'; moved: LedgerField[]; jeNo: string; originalJeNo: string | null; contraJeNo: string | null }
  | { ok: true; status: 'not_booked'; moved: LedgerField[]; reason: string }
  | { ok: false; status: 'reverse_failed' | 'repost_failed'; moved: LedgerField[]; reason: string };

const dayOf = (v: string | null | undefined): string => String(v ?? '').slice(0, 10);

const acquirerOf = (f: PaymentLedgerFacts): string | null => {
  if (f.method !== 'merchant' && f.method !== 'installment') return null;
  const name = String(f.merchantProvider ?? '').trim();
  return name === '' ? null : name;
};

export function ledgerBearingChange(before: PaymentLedgerFacts, after: PaymentLedgerFacts): LedgerField[] {
  const moved: LedgerField[] = [];
  if (before.amountSen !== after.amountSen) moved.push('amount');
  if (dayOf(before.paidOn) !== dayOf(after.paidOn)) moved.push('date');
  if (before.method !== after.method) moved.push('method');
  else if (acquirerOf(before) !== acquirerOf(after)) moved.push('acquirer');
  return moved;
}

/** The facts a payment ROW carries, whichever shape it arrives in. */
export const ledgerFactsOf = (row: {
  amount_sen?: number | null; paid_at?: string | null; method?: string | null; merchant_provider?: string | null;
}): PaymentLedgerFacts => ({
  amountSen: Number(row.amount_sen ?? 0),
  paidOn: dayOf(row.paid_at),
  method: String(row.method ?? ''),
  merchantProvider: row.merchant_provider ?? null,
});

/**
 * Reverse the entry an edited payment used to have, and book the payment as it
 * now stands. Idempotent — running it twice converges on one active entry,
 * because `postJournal` finds the live entry and answers `already_posted`.
 *
 * WHERE THE CONTRA IS DATED, and why it differs from a delete. The contra sits
 * on the ORIGINAL entry's date, not today: an edit is the correction of a
 * mistake made that day, so the wrong entry and its reversal must net to zero
 * in the month they were made. Dated today instead, a corrected RM 1,990 would
 * leave that money standing in one month's bank column and a matching negative
 * in another — precisely what the bank reconciliation this work serves cannot
 * absorb. A DELETE is left alone on purpose: removing a payment is an event
 * that happens today, and `afterSoPaymentRemoved` still dates its contra today.
 */
export async function repostSoPaymentEdit(
  sb: Db,
  p: { before: PaymentLedgerFacts; after: SoPaymentRow },
): Promise<RepostResult> {
  const moved = ledgerBearingChange(p.before, ledgerFactsOf(p.after));
  if (moved.length === 0) return { ok: true, status: 'unchanged', moved };

  const { data: existing, error: readErr } = await sb.from('journal_entries')
    .select('id, je_no, entry_date, reversed')
    .eq('source_type', 'SOPAY')
    .eq('source_doc_no', p.after.id);
  if (readErr) {
    return { ok: false, status: 'reverse_failed', moved, reason: `entry read: ${readErr.message}` };
  }
  const live = ((existing ?? []) as Array<{ je_no: string; entry_date: string | null; reversed: boolean | null }>)
    .find((r) => !r.reversed) ?? null;

  let originalJeNo: string | null = null;
  let contraJeNo: string | null = null;
  if (live) {
    const undone = await reverseJournal(sb, {
      sourceType: 'SOPAY',
      sourceDocNo: p.after.id,
      entryDate: dayOf(live.entry_date) || undefined,
      narration: (orig) => `Reversal of ${orig.je_no} — payment on ${p.after.so_doc_no} corrected (${moved.join(', ')})`,
    });
    if (!undone.ok) {
      return { ok: false, status: 'reverse_failed', moved, reason: `${undone.status}${undone.reason ? `: ${undone.reason}` : ''}` };
    }
    if (undone.status === 'reversed') { originalJeNo = undone.originalJeNo; contraJeNo = undone.jeNo; }
  }

  const rebooked: PostPaymentResult = await postSoPayment(sb, p.after);
  if (!rebooked.ok) {
    return { ok: false, status: 'repost_failed', moved, reason: `${rebooked.status}${rebooked.reason ? `: ${rebooked.reason}` : ''}` };
  }
  if (rebooked.status === 'posted' || rebooked.status === 'already_posted') {
    return { ok: true, status: 'reposted', moved, jeNo: rebooked.jeNo, originalJeNo, contraJeNo };
  }
  return { ok: true, status: 'not_booked', moved, reason: rebooked.status };
}
