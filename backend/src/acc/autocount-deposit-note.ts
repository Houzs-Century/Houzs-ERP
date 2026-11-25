// How an AutoCount deposit note is known (acc/autocount-deposits.ts raises it).
// A leaf with no imports: the credit-note readers (credit-note-si.ts, the AR
// Aging) need the mark, and the module that raises the note imports them.

/** The source document every AutoCount deposit note carries. */
export const AUTOCOUNT_DEPOSIT_REF = 'AUTOCOUNT DEPOSIT';

/** A customer note that brings an order's AutoCount deposit onto the customer. */
export const isAutoCountDepositNote = (n: { kind?: unknown; source_doc_no?: unknown } | null | undefined): boolean =>
  !!n && String(n.kind ?? '') === 'CN' && String(n.source_doc_no ?? '').trim().toUpperCase() === AUTOCOUNT_DEPOSIT_REF;
