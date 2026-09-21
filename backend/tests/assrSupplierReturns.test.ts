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
import { nextSupplierReturnRoundNo } from '../src/services/assrSupplierReturns';
import routeRaw from '../src/routes/assr.ts?raw';
import svcRaw from '../src/services/assrSupplierReturns.ts?raw';

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
