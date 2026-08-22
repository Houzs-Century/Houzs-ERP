// ----------------------------------------------------------------------------
// mrp-alloc-source — the case that put "ordered" over goods already received.
//
// The rule was three-way in routes/mrp.ts and TWO-way in the frontend's own
// copy (Mrp.tsx:307), which synthesises the sofa-SET rows. The missing arm was
// `stock`, so a set with no shortage and no covering PO — received, sitting in
// the warehouse — came back as `po`, and the chip printed the word "ordered"
// because it had no number to show.
//
// Owner 2026-08-21: 「然后我不是收货了吗？为什么是show PO outstanding？还显示
// ordered？那么奇怪的」.
// ----------------------------------------------------------------------------

import { describe, expect, test } from 'vitest';
import { allocSourceOf, allocSourceCoveringPo } from './mrp-alloc-source';

describe('allocSourceOf — is this demand covered, and by what', () => {
  /* THE REGRESSION. Nothing short, no PO: the goods are here. */
  test('no shortage and no PO is STOCK, not po', () => {
    expect(allocSourceOf(0, null)).toBe('stock');
  });

  test('a shortage wins over a covering PO', () => {
    expect(allocSourceOf(3, 'HC-PO-2608-001')).toBe('shortage');
  });

  test('covered by a PO that names itself', () => {
    expect(allocSourceOf(0, 'HC-PO-2608-001')).toBe('po');
  });

  /* A PO that cannot name itself is MISSING DATA, not an order. Calling it
     `po` is precisely what left the chip with nothing to print. */
  const UNNAMEABLE: Array<[string, string | null | undefined]> = [
    ['empty', ''], ['whitespace', '   '], ['null', null], ['absent', undefined],
  ];
  test.each(UNNAMEABLE)('an %s PO number is not a PO', (_label, poNumber) => {
    expect(allocSourceOf(0, poNumber)).toBe('stock');
  });

  test('a missing shortage figure reads as none', () => {
    expect(allocSourceOf(null, null)).toBe('stock');
    expect(allocSourceOf(undefined, 'HC-PO-2608-001')).toBe('po');
  });

  /* Negative shortage is not a surplus signal anywhere else in MRP; it must not
     become one here. */
  test('a negative shortage is not a shortage', () => {
    expect(allocSourceOf(-2, null)).toBe('stock');
  });
});

describe('allocSourceCoveringPo — is a PO involved in this line', () => {
  /* THE DELIBERATE DIFFERENCE. The purchase side asks a different question, and
     the two rules disagreeing on exactly this input is why both live here. */
  test('a named PO wins even when the line is still short', () => {
    expect(allocSourceCoveringPo(3, 'HC-PO-2608-001')).toBe('po');
    expect(allocSourceOf(3, 'HC-PO-2608-001')).toBe('shortage');
  });

  test('short with no PO is still a shortage', () => {
    expect(allocSourceCoveringPo(3, null)).toBe('shortage');
  });

  test('nothing short and no PO is stock here too', () => {
    expect(allocSourceCoveringPo(0, null)).toBe('stock');
  });

  test('an unnameable PO is not a PO here either', () => {
    expect(allocSourceCoveringPo(0, '  ')).toBe('stock');
    expect(allocSourceCoveringPo(3, '  ')).toBe('shortage');
  });
});
