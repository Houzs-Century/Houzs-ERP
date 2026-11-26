// How an AutoCount deposit note is known (acc/autocount-deposits.ts raises it).
// A leaf with no imports: the credit-note readers (credit-note-si.ts, the AR
// Aging) and the note's posting (credit-notes.ts) need the mark, and the
// module that raises the note imports them.

/** The source document every AutoCount deposit note carries. */
export const AUTOCOUNT_DEPOSIT_REF = 'AUTOCOUNT DEPOSIT';

/** A customer note that brings an order's AutoCount deposit onto the customer. */
export const isAutoCountDepositNote = (n: { kind?: unknown; source_doc_no?: unknown } | null | undefined): boolean =>
  !!n && String(n.kind ?? '') === 'CN' && String(n.source_doc_no ?? '').trim().toUpperCase() === AUTOCOUNT_DEPOSIT_REF;

/** AutoCount booked this share of its deposit sales as cost (619-0000 COST OF
    PURCHASE BASED ON DEPOSIT (34%), owner 2026-11-25: 「有，记了 34%」); the
    note's entry releases it. */
export const AUTOCOUNT_COST_PCT = 34;

/** The cost an AutoCount deposit note releases, in whole sen. */
export const autoCountCostSen = (depositSen: number): number => Math.round((depositSen * AUTOCOUNT_COST_PCT) / 100);
