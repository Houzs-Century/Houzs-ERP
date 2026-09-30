/* 二次返厂 (owner 2026-09-21). Two things must stay true and almost nothing else
 * pins them, both living in 2,000-3,000-line files where a refactor could
 * silently unhook them:
 *
 *  1. Round numbering NEVER reuses a number, even after a mistaken trip is
 *     archived — that is what keeps the round history honest.
 *  2. The three write routes sit UNDER /:id{...} so enforceCaseScope (the ASSR
 *     write-scope guard added in the 2026-07-23 audit) applies to them, they are
 *     gated on service_cases.write, and "send back again" genuinely REOPENS a
 *     completed case by clearing closed_at + the current-trip columns.
 *
 * The numbering is unit-tested for real; the wiring is source-anchored (same
 * style as acNotSentWiring.test.ts) because there is no DB in this suite. */
import { describe, expect, test } from 'vitest';
import { earlierSupplierReturns, nextSupplierReturnRoundNo } from '../src/services/assrSupplierReturns';
import routeRaw from '../src/routes/assr.ts?raw';
import svcRaw from '../src/services/assrSupplierReturns.ts?raw';
import printRaw from '../src/routes/assr_print.ts?raw';

describe('nextSupplierReturnRoundNo', () => {
  test('no trips yet -> 1', () => {
    expect(nextSupplierReturnRoundNo([])).toBe(1);
  });
  test('one previous trip -> 2 (this is 二次返厂)', () => {
    expect(nextSupplierReturnRoundNo([{ round_no: 1 }])).toBe(2);
  });
  test('an archived trip still consumes its number — the next is 3, never 2 again', () => {
    expect(nextSupplierReturnRoundNo([{ round_no: 1 }, { round_no: 2 }])).toBe(3);
  });
});

describe('earlierSupplierReturns — the 2nd trip paper also lists trip 1', () => {
  const t1 = { round_no: 1, ref_no: 'SVC-RTN-2609-0001', archived_at: null };
  const t2 = { round_no: 2, ref_no: 'SVC-RTN-2609-0002', archived_at: 'x' };
  const t3 = { round_no: 3, ref_no: 'SVC-RTN-2610-0001', archived_at: null };
  test('first trip has nothing earlier', () => {
    expect(earlierSupplierReturns([t1], t1)).toEqual([]);
  });
  test('trip 3 lists live earlier trips oldest first, skipping a removed one', () => {
    expect(earlierSupplierReturns([t3, t2, t1], t3).map((r) => r.ref_no)).toEqual(['SVC-RTN-2609-0001']);
  });
  test('no current trip -> nothing', () => {
    expect(earlierSupplierReturns([t1], null)).toEqual([]);
  });
});

describe('supplier print lists the earlier return numbers', () => {
  test('the trip box renders Previous Return No. from earlierSupplierReturns', () => {
    expect(printRaw).toMatch(/earlierSupplierReturns\(/);
    expect(printRaw).toMatch(/Previous Return No\./);
  });
});

describe('supplier-returns routes are scoped + gated', () => {
  test('all three sit under /:id/supplier-returns', () => {
    expect(routeRaw).toMatch(/app\.post\("\/:id\/supplier-returns"/);
    expect(routeRaw).toMatch(/app\.patch\("\/:id\/supplier-returns\/:roundId/);
    expect(routeRaw).toMatch(/app\.delete\("\/:id\/supplier-returns\/:roundId/);
  });
  test('all three require service_cases.write', () => {
    const hits = routeRaw.match(/supplier-returns[^\n]*requirePermission\("service_cases\.write"\)/g) ?? [];
    expect(hits.length).toBe(3);
  });
  test('enforceCaseScope is mounted on the /:id child paths these live under', () => {
    expect(routeRaw).toMatch(/app\.use\("\/:id\{\[0-9\]\+\}\/\*", enforceCaseScope\)/);
  });
});

describe('adding a return reopens a completed case + mirrors to the case columns', () => {
  test('openSupplierReturn clears closed_at when the case was terminal', () => {
    expect(svcRaw).toMatch(/if \(before\.closed_at\)/);
    expect(svcRaw).toMatch(/closed_at = NULL, completion_date = NULL/);
  });
  test('the case summary columns mirror the current (latest) round', () => {
    // reprojectLatestSupplierReturn writes the current round back onto the case.
    expect(svcRaw).toMatch(/SET supplier_pickup_at = \?, items_ready_at = \?/);
    expect(svcRaw).toMatch(/reprojectLatestSupplierReturn/);
  });
});
