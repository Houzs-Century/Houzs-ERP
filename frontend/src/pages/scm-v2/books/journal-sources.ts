// ----------------------------------------------------------------------------
// journal-sources — every source a journal entry is written from, as the
// Journal entries' Source filter offers it and the entry card names it (the
// owner's redesign, batch 6 §2.3 a2). ONE list: the engine's own vocabulary —
// the journal classes' fixed and money-side types (backend acc/journal-class)
// and the document types its rules post (acc/rules REVERSAL_SOURCE) — each
// with its reversal, `<TYPE>_REVERSAL`. The filter is a server parameter, so a
// type missing here could not be picked; the design's labels are the model
// ("SI · Sales invoice"). A type the list does not know is named by itself.
// ----------------------------------------------------------------------------

export type JournalSource = { code: string; label: string };

/** The documents and runs that post, in journal order: sales, money in,
    purchases, money out, cards, then the general journal. */
export const JOURNAL_SOURCES: readonly JournalSource[] = [
  { code: 'SI', label: 'SI · Sales invoice' },
  { code: 'DI', label: 'DI · Deposit invoice' },
  { code: 'CN', label: 'CN · Credit note' },
  { code: 'DN', label: 'DN · Debit note' },
  { code: 'ODB', label: 'Debtor bill' },
  { code: 'OCN', label: 'OCN · Other debtor credit note' },
  { code: 'SOPAY', label: 'Order payment' },
  { code: 'SIPAY', label: 'Invoice payment' },
  { code: 'SOCONV', label: 'Money moved between orders' },
  { code: 'ODR', label: 'Debtor receipt' },
  { code: 'RCT', label: 'Sundry receipt' },
  { code: 'PI', label: 'PI · Purchase invoice' },
  { code: 'API', label: 'AP invoice' },
  { code: 'SCN', label: 'SCN · Supplier credit note' },
  { code: 'PV', label: 'PV · Payment voucher' },
  { code: 'SETTLE', label: 'Card settlement' },
  { code: 'SETTLEMOVE', label: 'Card money moved' },
  { code: 'SETTLEADJ', label: 'Card statement charge' },
  { code: 'SETTLEBANK', label: 'Card payout' },
  { code: 'SETTLECHARGE', label: 'Payout bank charge' },
  { code: 'CASHUP', label: 'Daily close cash' },
  { code: 'STOCKADJ', label: 'Stock close' },
  { code: 'OPENING', label: 'Opening balance' },
  { code: 'MANUAL', label: 'Manual' },
];

const REVERSAL = /_REVERSAL$/;

/** The short name a reversal is called by: "SI reversal", "Manual reversal". */
const shortOf = (label: string): string => label.split(' · ')[0] ?? label;

/** The reversals, one per source, in the same order. */
export const JOURNAL_REVERSALS: readonly JournalSource[] = JOURNAL_SOURCES.map((s) => ({
  code: `${s.code}_REVERSAL`,
  label: `${shortOf(s.label)} reversal`,
}));

/** What a source type is called — its own code when the list does not know it. */
export function sourceLabel(type: string | null | undefined): string {
  const t = String(type ?? '');
  const base = t.replace(REVERSAL, '');
  const known = JOURNAL_SOURCES.find((s) => s.code === base);
  if (!known) return t || '—';
  return REVERSAL.test(t) ? `${shortOf(known.label)} reversal` : known.label;
}

/** A manual journal — the only entry the card may post, edit, copy or reverse
    (owner question g3); a document's entry is corrected through its document. */
export const isManualSource = (type: string | null | undefined): boolean => String(type ?? '') === 'MANUAL';
