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
  /* This block used to assert `tsStockOut === [...tsShipped, 'COMPLETED']` —
     "stock-out is the shipped set plus COMPLETED, in that order" — and called it
     the state machine's requirement. It encoded a belief production has since
     refuted, and a test that pins a false belief is worse than no test: it makes
     the correction look like the regression. See the header of
     src/scm/shared/do-shipped-states.ts for the evidence. */
  test('stock-out and shipped are equal, since COMPLETED left both', () => {
    expect([...tsStockOut]).toEqual([...tsShipped]);
  });

  test('COMPLETED is in no set here — scm.do_status has no such label', () => {
    /* The gap this closes is the WRITE path. DO_STATUSES is what
       PATCH /delivery-orders-mfg/:id/status validates the request body against
       (delivery-orders-mfg.ts:369, guard at :5374), so a value listed here that
       the enum lacks is accepted by the guard and then 500s at the UPDATE — a
       whitelist that admits an impossible value is not a whitelist. */
    expect(tsShipped).not.toContain('COMPLETED');
    expect(tsStockOut).not.toContain('COMPLETED');
    expect(tsAll).not.toContain('COMPLETED');
    expect(jsShipped).not.toContain('COMPLETED');
    expect(jsStockOut).not.toContain('COMPLETED');
  });

  test('the vocabulary is exactly the eight labels of scm.do_status', () => {
    /* Typed out rather than derived, on purpose: derived from the same constants
       it is checking, this test would agree with any future edit. The list is
       the enum as the database has it — 2990s-full-schema.sql:5 (seven labels)
       plus DRAFT from mig 0040_scm_do_status_draft.sql. Adding a value here
       without an ALTER TYPE in migrations-pg/ is what produced the COMPLETED
       bug, so a new status has to change this line and a migration together. */
    expect([...tsAll].sort()).toEqual(
      ['CANCELLED', 'DELIVERED', 'DISPATCHED', 'DRAFT', 'INVOICED', 'IN_TRANSIT', 'LOADED', 'SIGNED'],
    );
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
