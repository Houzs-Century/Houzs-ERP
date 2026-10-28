/* ----------------------------------------------------------------------------
   ac-line-order-sweep — does this document's lines still look like the ERP's?

   WHY IT EXISTS. Three separate migrated documents were found by the owner
   OPENING them: the lines in a different order from the ERP's, and in one case
   a line he had deleted still sitting in the book at Qty 0. After the third:

       「之后有问题吗？我不要每次都来 fix 啊」

   He chose to measure the whole population rather than keep fixing one document
   at a time. This is the comparison half of that; the host's
   `/line-fingerprints` is the other half.

   PURE. No database, no AutoCount, no clock — so every rule below is testable,
   which the last three one-off diagnoses were not.

   IT COMPARES AGAINST WHAT WOULD ACTUALLY BE SENT, not against the ERP's raw
   rows. `composeDetails` collapses a sofa's compartment lines into the one line
   AutoCount holds, so a sofa order legitimately has FEWER lines in the book. A
   sweep that compared raw rows would report every sofa document as broken, and
   the true findings would be invisible inside the noise.

   A VERDICT NAMES WHAT IS WRONG, not just that something is. "Different" is not
   actionable; "the book carries a line the ERP does not" is — it is the deleted
   line, and a rebuild removes it. The four failing verdicts are deliberately
   distinguishable because they have different remedies and different urgency.
   -------------------------------------------------------------------------- */

/** One document as `/line-fingerprints` reports it. */
export interface BookFingerprint {
  DocNo: string;
  Lines: number;
  /** The ordered ItemCodes, joined by `|`, in AutoCount's own `Seq` order. */
  Codes: string;
}

export type SweepVerdict =
  /** The book's lines are the ERP's lines, in the ERP's order. Nothing to do. */
  | 'match'
  /** Same lines, different ORDER. A rebuild re-lays them. */
  | 'order'
  /** The book holds a line the ERP does not — the deleted-line case. */
  | 'extra_in_book'
  /** The ERP holds a line the book does not — an add that never landed. */
  | 'missing_in_book'
  /** Both, so neither single word would be true. */
  | 'different'
  /** The ERP says it is linked to a document the book does not have. */
  | 'not_in_book'
  /** The ERP's own lines could not be composed, so there is nothing to compare. */
  | 'cannot_compose';

/** The verdicts that mean a document needs doing something about. */
export const SWEEP_FAILING: readonly SweepVerdict[] = [
  'order', 'extra_in_book', 'missing_in_book', 'different', 'not_in_book',
];

/**
 * The book's ordered codes.
 *
 * An EMPTY string is zero lines, not one empty line — `''.split('|')` answers
 * `['']`, which would compare as a document carrying one blank item and read as
 * a mismatch on every empty document.
 */
export function bookCodesOf(f: Pick<BookFingerprint, 'Codes'>): string[] {
  return f.Codes.length === 0 ? [] : f.Codes.split('|');
}

function multisetMinus(a: readonly string[], b: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of b) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of a) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

/**
 * Compare one document.
 *
 * `book === null` means the fingerprint set did not carry it; `erp === null`
 * means composing the ERP's own lines threw. Both are answers, not errors — a
 * sweep that stopped on the first unmappable item code would measure nothing.
 */
export function compareLineOrder(
  book: readonly string[] | null,
  erp: readonly string[] | null,
): SweepVerdict {
  /* Checked BEFORE `not_in_book`: if we cannot say what the ERP would send, we
     cannot say the book is missing it either. */
  if (erp === null) return 'cannot_compose';
  if (book === null) return 'not_in_book';
  if (book.length === erp.length && book.every((c, i) => c === erp[i])) return 'match';
  const extra = multisetMinus(book, erp);
  const missing = multisetMinus(erp, book);
  if (extra.length === 0 && missing.length === 0) return 'order';
  if (missing.length === 0) return 'extra_in_book';
  if (extra.length === 0) return 'missing_in_book';
  return 'different';
}

export interface SweepRow {
  docNo: string;
  verdict: SweepVerdict;
  bookLines: number | null;
  erpLines: number | null;
}

export interface SweepSummary {
  total: number;
  byVerdict: Record<SweepVerdict, number>;
  /** The documents needing action, worst first, capped by the caller. */
  failing: SweepRow[];
}

const ALL_VERDICTS: readonly SweepVerdict[] = [
  'match', 'order', 'extra_in_book', 'missing_in_book', 'different',
  'not_in_book', 'cannot_compose',
];

/* Worst first, so a truncated list still shows the documents that matter most.
   `extra_in_book` leads because it is a WRONG line in a licensed account book —
   the shape the owner has now found three times — while `order` is confusing
   but carries no wrong value. */
const SEVERITY: readonly SweepVerdict[] = [
  'extra_in_book', 'different', 'missing_in_book', 'not_in_book', 'order',
  'cannot_compose', 'match',
];

/**
 * Roll the per-document verdicts up.
 *
 * `cap` is REQUIRED rather than defaulted: it decides how much of a public run
 * log this fills, and a silent default is exactly the kind of decision
 * CLAUDE.md says must fail to compile instead of being forgotten.
 */
export function summariseSweep(rows: readonly SweepRow[], cap: number): SweepSummary {
  const byVerdict = Object.fromEntries(ALL_VERDICTS.map((v) => [v, 0])) as Record<SweepVerdict, number>;
  for (const r of rows) byVerdict[r.verdict] += 1;
  const failing = rows
    .filter((r) => SWEEP_FAILING.includes(r.verdict))
    .sort((a, b) => SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict)
      || a.docNo.localeCompare(b.docNo))
    .slice(0, cap);
  return { total: rows.length, byVerdict, failing };
}
