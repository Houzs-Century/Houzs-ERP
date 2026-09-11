/* Has this payment already been reconciled?

   The server's half of the rule `paymentRowMutable` has reserved a place for
   since 2026-07-19, in the owner's words: 「如果他已经做完 bank record 并且
   knock off 掉了，就不行了」. Finance may correct a mis-keyed payment (owner +
   management, 2026-09-10) — but not one the books have already closed over.

   THREE places can have closed over it, and they are genuinely different, so
   all three are named rather than collapsed into one "reconciled" flag: an
   operator told only that cannot go and look at the one that did.

     merchant — `acc_settlement_matches` claims the payment ROW itself, and
                the settlement LINE it points at has been CONFIRMED — its fee
                booked, `confirmed_at` set. The link alone is the matcher's
                word (the upload writes one for every line it matched by
                reference, before anybody has looked) and locks nothing
                (docs/bugs/0821). This is the only one that speaks for a
                payment that never reached the ledger, because it keys on the
                row, not the entry.
     bank     — `acc_bank_statement_matches` claims its ACTIVE journal entry by
                number. One entry cannot account for two movements.
     month    — that entry's MONEY account has its month closed in
                `acc_bank_month_locks`. Nothing in the month may move.

   EVERY READ FAILS CLOSED. "I could not tell" must never come back as "no", or
   the guard turns itself off exactly when the database is unhappy — the same
   rule, for the same reason, as `loadLineMonth` in acc/bank.ts. */

import { loadLiveMonthLock } from './bank';
import { lockMonthOf } from './bank-lock';
import {
  paymentRowMutable,
  type PaymentReconciledBy,
  type PaymentRowMutability,
} from '../scm/shared/so-field-policy';
import { postSoPayment } from './payments';

/** The permission Finance holds to correct a payment after the day it was
    keyed. Named here so the two routes and any later surface spell it once. */
export const SO_PAYMENT_AMEND = 'scm.so_payment.amend';

/* Borrowed from the poster rather than spelled out again — a new file's lint
   ceiling is zero, and a second name for the same client would be worse. */
type Db = Parameters<typeof postSoPayment>[0];

export type PaymentReconciliation =
  | { ok: true; by: PaymentReconciledBy | null }
  | { ok: false; reason: string };

const dayOf = (v: unknown): string => String(v ?? '').slice(0, 10);

export async function paymentReconciliation(
  sb: Db,
  companyId: number,
  paymentId: string,
  source: 'SOPAY' | 'SIPAY' = 'SOPAY',
): Promise<PaymentReconciliation> {
  /* 1. THE MERCHANT REPORT. First because it is the cheapest, the most exact
        (the table's unique index is on the payment itself) and the only one
        that answers for a payment with no ledger entry at all. */
  const { data: matched, error: matchErr } = await sb.from('acc_settlement_matches')
    .select('settlement_row_id, created_at')
    .eq('company_id', companyId)
    .eq('payment_source', source)
    .eq('payment_id', paymentId);
  if (matchErr) return { ok: false, reason: `settlement match: ${matchErr.message}` };
  const links = (matched ?? []) as Array<{ settlement_row_id: number | null; created_at: string | null }>;
  /* A LINK IS THE MATCHER'S WORD, NOT A RECONCILIATION (docs/bugs/0821). The
     upload writes one for every line it matched by reference, before anybody
     has looked; only a line somebody CONFIRMED — its fee booked, confirmed_at
     set — has closed the books over the payment. So the LINE is read, not the
     link: under an unconfirmed one the payment stays correctable, which is
     exactly when a mis-keyed amount gets fixed (bank 3,052.00, keyed 3,053.00,
     2990-SO-2607-012). Confirming reads the amount back from the row, so the
     correction is what settles. */
  const lineIds = [...new Set(links.map((l) => Number(l.settlement_row_id)).filter((n) => Number.isInteger(n)))];
  if (lineIds.length > 0) {
    const { data: linesRaw, error: lineErr } = await sb.from('acc_settlement_rows')
      .select('id, confirmed_at, posted_je_no')
      .eq('company_id', companyId)
      .in('id', lineIds);
    if (lineErr) return { ok: false, reason: `settlement line: ${lineErr.message}` };
    const confirmed = ((linesRaw ?? []) as Array<{ id: number; confirmed_at: string | null; posted_je_no: string | null }>)
      .find((r) => r.confirmed_at != null || r.posted_je_no != null);
    if (confirmed) {
      return { ok: true, by: { kind: 'merchant', on: dayOf(confirmed.confirmed_at ?? links.at(0)?.created_at) } };
    }
  }

  /* 2. THE ENTRY the other two speak through. `reversed` is filtered in
        JavaScript, not in the query: it defaults to FALSE in Postgres but is
        ABSENT on a freshly inserted row in the fake client, so `.eq(...)` on it
        matches nothing and the guard would quietly find no entry to protect
        (docs/bugs/0778 shipped that mistake once already). */
  const { data: jes, error: jeErr } = await sb.from('journal_entries')
    .select('id, je_no, entry_date, reversed')
    .eq('company_id', companyId)
    .eq('source_type', source)
    .eq('source_doc_no', paymentId)
    .eq('posted', true);
  if (jeErr) return { ok: false, reason: `entry read: ${jeErr.message}` };
  const live = ((jes ?? []) as Array<{ id: string; je_no: string; entry_date: string | null; reversed: boolean | null }>)
    .find((r) => !r.reversed);
  /* No live entry: nothing for a bank statement or a month lock to have closed
     over. Not reconciled — and the unbooked Self-check card is the one that
     speaks for this state, not this function. */
  if (!live) return { ok: true, by: null };

  /* 3. THE BANK STATEMENT. Keyed by je_no, which is what the matches table
        carries — see its own column comment for why it is the number and not
        the uuid. */
  const { data: claimed, error: claimErr } = await sb.from('acc_bank_statement_matches')
    .select('je_no')
    .eq('company_id', companyId)
    .eq('je_no', live.je_no)
    .limit(1);
  if (claimErr) return { ok: false, reason: `bank match: ${claimErr.message}` };
  if (((claimed ?? []) as unknown[]).length > 0) {
    return { ok: true, by: { kind: 'bank', jeNo: live.je_no } };
  }

  /* 4. THE CLOSED MONTH, read off the entry's MONEY leg. The credit leg is
        Trade Debtors and is never a bank account, so a guard that took the
        wrong line would find no lock and wave everything through. */
  const { data: lineRows, error: lineErr } = await sb.from('journal_entry_lines')
    .select('account_code, debit_sen')
    .eq('journal_entry_id', live.id);
  if (lineErr) return { ok: false, reason: `entry lines: ${lineErr.message}` };
  const money = ((lineRows ?? []) as Array<{ account_code: string; debit_sen: number | null }>)
    .find((l) => Number(l.debit_sen ?? 0) > 0);
  if (!money) return { ok: true, by: null };

  const month = lockMonthOf(dayOf(live.entry_date));
  const lock = await loadLiveMonthLock(sb, companyId, money.account_code, month);
  if (!lock.ok) return { ok: false, reason: `month lock: ${lock.reason}` };
  if (lock.lock) {
    return { ok: true, by: { kind: 'month', accountCode: money.account_code, month } };
  }

  return { ok: true, by: null };
}

/** Why a payment was not changed when the check itself could not run. Fails
    CLOSED, and says so in a sentence the operator can act on: "try again" is
    true, and it does not pretend the payment is locked forever. */
export const RECONCILIATION_UNREADABLE =
  'Could not check whether this payment has already been reconciled, so nothing was changed. '
  + 'Try again in a moment, and tell IT if it keeps happening.';

/**
 * The whole answer to "may this payment still be changed", reconciliation
 * included — the shape both the PATCH and the DELETE ask for.
 *
 * ONE call rather than "load the reconciliation, then call the predicate",
 * because those two steps have to stay in step and a route that did only the
 * first half would read as if it had checked. The predicate itself
 * (`paymentRowMutable`) remains the only place the RULE lives; this only feeds
 * it the fact it cannot fetch for itself.
 */
export async function paymentMayChange(
  sb: Db,
  p: {
    companyId: number;
    paymentId: string;
    /** The MY calendar day the ROW was keyed — never the date on the document. */
    createdDateMyt: string;
    todayDateMyt: string;
    soIsDraft: boolean;
    mayAmend: boolean;
    source?: 'SOPAY' | 'SIPAY';
  },
): Promise<PaymentRowMutability> {
  /* A DRAFT order is exempt before anything is read: its payments were never
     locked, and there is no reason to ask the settlement tables about one. */
  if (p.soIsDraft) return { mutable: true, problem: null, via: 'draft' };

  const found = await paymentReconciliation(sb, p.companyId, p.paymentId, p.source ?? 'SOPAY');
  if (!found.ok) {
    /* eslint-disable-next-line no-console */
    console.error('[acc] reconciliation check failed for payment', p.paymentId, found.reason);
    return { mutable: false, problem: RECONCILIATION_UNREADABLE, via: null };
  }
  return paymentRowMutable(p.createdDateMyt, p.todayDateMyt, false, {
    mayAmend: p.mayAmend,
    reconciled: found.by,
  });
}
