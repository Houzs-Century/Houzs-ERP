import { describe, expect, test } from 'vitest';
import {
  DO_SHIPPED_STATES as tsShipped,
  DO_STOCK_OUT_STATES as tsStockOut,
  DO_STATUSES as tsAll,
  DO_PRESHIP_STATES as tsPreship,
} from '../src/scm/shared/do-shipped-states';
// @ts-expect-error - plain .mjs mirror for audit scripts
import {
  DO_SHIPPED_STATES as jsShipped,
  DO_STOCK_OUT_STATES as jsStockOut,
} from '../scripts/lib/do-shipped-states.mjs';

/* scripts/lib/do-shipped-states.mjs is a hand copy of the two status sets in
   src/scm/shared/do-shipped-states.ts, because a .mjs audit cannot import
   TypeScript. This test is the pin — same role phoneNormaliseMirror.test.ts and
   variantAxesMirror.test.ts play for their copies.

   It matters more than a usual mirror: these sets decide WHICH DELIVERY ORDERS
   AN AUDIT LOOKS AT. An audit reading a narrower set than the write path uses
   reports "clean" about rows it never selected, which is the exact way the
   fabric sweeps kept coming out clean while the data was not. */

describe('do-shipped-states.mjs mirrors do-shipped-states.ts', () => {
  test('the write-trigger set is identical', () => {
    expect([...jsShipped]).toEqual([...tsShipped]);
  });

  test('the stock-out set is identical', () => {
    expect([...jsStockOut]).toEqual([...tsStockOut]);
  });
});

describe('the two sets stay related the way the DO state machine requires', () => {
  /* Not style. COMPLETED must be OUT of the write-trigger set (nothing ships
     into completion — a second deduction would fire on that hop) and IN the
     read set (a COMPLETED DO has certainly shipped, so it must not fall back to
     a pre-ship status). Anyone "simplifying" these into one list breaks exactly
     one of those two, silently. */
  test('stock-out is the shipped set plus COMPLETED, in that order', () => {
    expect([...tsStockOut]).toEqual([...tsShipped, 'COMPLETED']);
  });

  test('COMPLETED never arms the deduction', () => {
    expect(tsShipped).not.toContain('COMPLETED');
  });

  test('every stock-out state is a legal DO status', () => {
    for (const s of tsStockOut) expect(tsAll).toContain(s);
  });

  test('the vocabulary is exactly pre-ship + stock-out + CANCELLED', () => {
    expect([...tsAll].sort()).toEqual(
      [...new Set([...tsPreship, ...tsStockOut, 'CANCELLED'])].sort(),
    );
  });

  test('a pre-ship state is never a stock-out state', () => {
    for (const s of tsPreship) expect(tsStockOut).not.toContain(s);
  });
});
