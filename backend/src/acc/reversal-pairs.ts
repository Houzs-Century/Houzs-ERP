// ----------------------------------------------------------------------------
// acc/reversal-pairs — a reversed journal and the contra that undid it are ONE
// correction, and the books show neither side.
//
// Owner 2026-09-15 (docs/bugs/0923): 照理就是对冲掉，所以都不应该显示，je 可以留记录就好.
// The pair stays in the journal — the list still marks the original 已冲销 and
// both entries still open — but no statement, ledger, board or reconciliation
// counts either side, whatever period it is cut to. A contra dated in a later
// month is not that month's movement: it undoes a keying error.
//
// Before this, every reader drew the line somewhere else. The statements and
// the receipts & payments skipped the flagged ORIGINAL and counted the contra
// in its own month (an August sale keyed twice read as −RM 1,610 of September
// sales); the general ledger stream printed both; the trial balance summed
// both sides AND every unposted draft; only the bank reconciliation skipped
// the pair (docs/bugs/0802). One predicate, read by all of them.
//
// The flags are scm.journal_entries' own, exposed by scm.v_gl_entries:
// `reversed` marks the original, `reversed_by_je` links BOTH sides — the
// original to its contra, the contra back to the original (acc/engine.ts
// reverseJournal writes both).
// ----------------------------------------------------------------------------

export type PairFlags = { reversed?: boolean | null; reversed_by_je?: string | null };

/** Either side of a reversal pair — the original, or the contra that undid it. */
export const isReversalPair = (r: PairFlags): boolean => r.reversed === true || r.reversed_by_je != null;

/** A line the books count: posted, and on neither side of a reversal. */
export const countsInTheBooks = (r: PairFlags & { posted?: boolean | null }): boolean =>
  r.posted === true && !isReversalPair(r);
