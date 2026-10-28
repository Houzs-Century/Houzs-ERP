// ----------------------------------------------------------------------------
// THE SWEEP MUST NAME WHAT IS WRONG, AND MUST NOT INVENT A FINDING.
//
// The owner found three migrated documents by opening them one at a time, and
// then asked for the whole population instead:
//
//   「之后有问题吗？我不要每次都来 fix 啊」
//
// A sweep is only worth running if its verdicts are trustworthy in BOTH
// directions. A false finding sends someone rebuilding a live account book for
// nothing; a missed one is why he keeps finding these by hand.
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import {
  bookCodesOf,
  compareLineOrder,
  summariseSweep,
  type SweepRow,
} from '../src/scm/lib/ac-line-order-sweep';

describe('reading the book fingerprint', () => {
  test('an empty document is zero lines, not one blank line', () => {
    /* ''.split('|') answers [''] — one blank item — which would make every
       empty document report a mismatch against an empty ERP list. */
    expect(bookCodesOf({ Codes: '' })).toEqual([]);
    expect(compareLineOrder(bookCodesOf({ Codes: '' }), [])).toBe('match');
  });

  test('a single line has no separator to split on', () => {
    expect(bookCodesOf({ Codes: 'AKEMI-Q' })).toEqual(['AKEMI-Q']);
  });

  test('a blank ItemCode in the middle survives as a blank, not as a gap', () => {
    /* The host writes ISNULL(ItemCode,'') — and 7 blank ItemCodes were really
       put into the live book on 2026-09-02 (docs/bugs/0615). The sweep has to
       be able to SEE them, so they must not be silently dropped here. */
    expect(bookCodesOf({ Codes: 'A||B' })).toEqual(['A', '', 'B']);
  });
});

describe('the verdicts', () => {
  test('same lines in the same order is a match', () => {
    expect(compareLineOrder(['A', 'B', 'C'], ['A', 'B', 'C'])).toBe('match');
  });

  test('same lines in a different order is ORDER, not different', () => {
    expect(compareLineOrder(['C', 'A', 'B'], ['A', 'B', 'C'])).toBe('order');
  });

  /* THE CASE THIS WAS BUILT FOR. SO-013361: the ERP deleted JAGER BEDFRAME and
     the book still held it at Qty 0. */
  test('a line the book holds and the ERP does not is EXTRA_IN_BOOK', () => {
    expect(compareLineOrder(['A', 'JAGER', 'B'], ['A', 'B'])).toBe('extra_in_book');
  });

  test('a line the ERP holds and the book does not is MISSING_IN_BOOK', () => {
    expect(compareLineOrder(['A'], ['A', 'B'])).toBe('missing_in_book');
  });

  test('both at once refuses to pick one word', () => {
    expect(compareLineOrder(['A', 'X'], ['A', 'Y'])).toBe('different');
  });

  test('a duplicated line is not cancelled out by a multiset comparison', () => {
    /* Two of the same item is a real shape. Comparing SETS would call these
       equal and miss a genuinely doubled line. */
    expect(compareLineOrder(['A', 'A'], ['A'])).toBe('extra_in_book');
    expect(compareLineOrder(['A'], ['A', 'A'])).toBe('missing_in_book');
  });

  test('a reorder that also gains a line is never called a mere reorder', () => {
    expect(compareLineOrder(['B', 'A', 'C'], ['A', 'B'])).toBe('extra_in_book');
  });
});

describe('the two answers that are not comparisons', () => {
  test('a document the book does not carry is NOT_IN_BOOK', () => {
    expect(compareLineOrder(null, ['A'])).toBe('not_in_book');
  });

  test('an ERP document that cannot be composed is CANNOT_COMPOSE', () => {
    expect(compareLineOrder(['A'], null)).toBe('cannot_compose');
  });

  /* ORDER MATTERS BETWEEN THESE TWO. If we cannot say what the ERP would send,
     we cannot claim the book is missing it either — reporting `not_in_book`
     there would be a finding invented out of our own inability to compose. */
  test('cannot_compose wins when both are unknown', () => {
    expect(compareLineOrder(null, null)).toBe('cannot_compose');
  });
});

describe('the roll-up', () => {
  const rows: SweepRow[] = [
    { docNo: 'SO-1', verdict: 'match', bookLines: 3, erpLines: 3 },
    { docNo: 'SO-2', verdict: 'order', bookLines: 3, erpLines: 3 },
    { docNo: 'SO-3', verdict: 'extra_in_book', bookLines: 9, erpLines: 8 },
    { docNo: 'SO-4', verdict: 'match', bookLines: 1, erpLines: 1 },
    { docNo: 'SO-5', verdict: 'cannot_compose', bookLines: 2, erpLines: null },
  ];

  test('every verdict is counted, including the ones with no rows', () => {
    const s = summariseSweep(rows, 10);
    expect(s.total).toBe(5);
    expect(s.byVerdict.match).toBe(2);
    expect(s.byVerdict.order).toBe(1);
    expect(s.byVerdict.extra_in_book).toBe(1);
    expect(s.byVerdict.different).toBe(0);
  });

  test('a matching document is never listed as failing', () => {
    expect(summariseSweep(rows, 10).failing.map((r) => r.docNo)).not.toContain('SO-1');
  });

  /* cannot_compose is a gap in OUR knowledge, not a defect in the book. Listing
     it as something to go and fix would send someone rebuilding a document that
     may be perfectly correct. */
  test('cannot_compose is counted but is not something to go and fix', () => {
    const s = summariseSweep(rows, 10);
    expect(s.byVerdict.cannot_compose).toBe(1);
    expect(s.failing.map((r) => r.docNo)).not.toContain('SO-5');
  });

  test('the wrong-line case is listed before the merely-reordered one', () => {
    expect(summariseSweep(rows, 10).failing.map((r) => r.docNo)).toEqual(['SO-3', 'SO-2']);
  });

  test('the cap truncates the LIST and never the counts', () => {
    const s = summariseSweep(rows, 1);
    expect(s.failing).toHaveLength(1);
    expect(s.byVerdict.order).toBe(1);
    expect(s.total).toBe(5);
  });
});
