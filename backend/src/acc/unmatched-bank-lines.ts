// ----------------------------------------------------------------------------
// unmatched-bank-lines — money the BANK shows coming in that nothing in the
// books is matched to yet: the third list on Payments not matched yet (owner
// 2026-11-10: 如果银行那边的收款有，也没有对应的transaction 也可以显示 → 做).
//
// A line is listed while it is OPEN and money IN, dated in the window; a repeat
// of a movement another file already recorded is a copy, not money, and is left
// out. What each one IS comes from Bank Recon's own deciders, read live the way
// a statement and a month read them — the door
// (scm/routes/accounting-unmatched-payments.ts) runs them; this file only names
// the answer and orders the list, so the words have one home:
//   CARD     — an acquirer's payout (PAYOUT, PAYOUT_SPLIT, PAYOUT_UNSURE,
//              PAYOUT_NO_BATCH): the matcher's clue says which report it waits for;
//   QR       — a day's DuitNow QR money, paid by its Online sales;
//   TRANSFER — the rest: the entries of the same amount within the matching
//              window that no bank line holds yet (acc/bank-match
//              entryCandidatesFor); none means its receipt is not in the books.
// ----------------------------------------------------------------------------

import { ENTRY_MATCH_WINDOW_DAYS } from './bank-match';
import { dayGap } from './unmatched-payments';

export type BankLineWhat = 'CARD' | 'QR' | 'TRANSFER';

/** One OPEN money-in line, as Bank Recon decides it today. */
export type DecidedBankLine = {
  id: number;
  statementId: number;
  accountCode: string;
  bookedOn: string;
  description: string;
  reference: string | null;
  amountSen: number;
  /** The live decision: PAYOUT*, QR or OTHER. */
  kind: string;
  acquirerCode: string | null;
  /** The decider's own sentence for it. */
  note: string | null;
};

/** An entry in the books this money could be. */
export type EntryOffer = { jeNo: string; entryDate: string; doc: string | null; who: string | null; daysApart: number };

export type UnmatchedBankLine = {
  lineId: number;
  statementId: number;
  accountCode: string;
  bankName: string | null;
  bookedOn: string;
  /** YYYY-MM — the month Bank statements opens it in. */
  month: string;
  description: string;
  reference: string | null;
  amountSen: number;
  what: BankLineWhat;
  kind: string;
  acquirerCode: string | null;
  /** Why it is still open, in one sentence: the decider's own for card and QR
      money, the entries it could be for a transfer. */
  note: string | null;
  /** TRANSFER: how many same-amount entries no bank line holds, and the first few. */
  entryCount: number;
  entries: EntryOffer[];
  ageDays: number;
};

/** How many of a transfer's possible entries the list names. */
export const MAX_ENTRY_OFFERS = 3;

export const whatOf = (kind: string): BankLineWhat =>
  (kind === 'QR' ? 'QR' : kind.startsWith('PAYOUT') ? 'CARD' : 'TRANSFER');

const shownDay = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** A transfer's sentence: the entries of its amount it could be, or that there is none. */
export function transferWords(offers: readonly EntryOffer[]): string {
  const first = offers[0];
  if (!first) return `No entry of this amount in the books within ${ENTRY_MATCH_WINDOW_DAYS} days of it — record the receipt first.`;
  if (offers.length === 1) {
    const who = [first.doc, first.who].filter(Boolean).join(' · ') || first.jeNo;
    return `One entry of this amount: ${who}, ${shownDay(first.entryDate)} — match it on Bank statements.`;
  }
  return `${offers.length} entries of this amount within ${ENTRY_MATCH_WINDOW_DAYS} days — pick the right one on Bank statements.`;
}

/** The list, oldest first — the money that has waited longest is the one to chase. */
export function unmatchedBankLinesOf(
  lines: readonly DecidedBankLine[],
  offersOf: (line: DecidedBankLine) => readonly EntryOffer[],
  bankNameOf: (accountCode: string) => string | null,
  today: string,
): UnmatchedBankLine[] {
  return lines
    .filter((l) => l.amountSen > 0)
    .map((l): UnmatchedBankLine => {
      const what = whatOf(l.kind);
      const offers = what === 'TRANSFER' ? offersOf(l) : [];
      return {
        lineId: l.id,
        statementId: l.statementId,
        accountCode: l.accountCode,
        bankName: bankNameOf(l.accountCode),
        bookedOn: l.bookedOn,
        month: l.bookedOn.slice(0, 7),
        description: l.description,
        reference: l.reference,
        amountSen: l.amountSen,
        what,
        kind: l.kind,
        acquirerCode: l.acquirerCode,
        note: what === 'TRANSFER' ? transferWords(offers) : l.note,
        entryCount: offers.length,
        entries: offers.slice(0, MAX_ENTRY_OFFERS),
        ageDays: dayGap(l.bookedOn, today),
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays || a.accountCode.localeCompare(b.accountCode) || a.lineId - b.lineId);
}
