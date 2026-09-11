// ----------------------------------------------------------------------------
// SETTING THE PROCESSING DATE MUST RE-WALK THE ALLOCATOR.
//
// The processing date is the allocator's gate: `so-stock-allocation.ts` skips
// any order without one (`allocGated`, the owner's 2026-08-10 rule). So an order
// acquires its claim on stock at the moment the header PATCH writes that date —
// and until 2026-09-11 nothing re-walked when it did. Only the LINE routes (add
// / edit / delete) and two manual endpoints called the allocator; the gate could
// open with nobody watching.
//
// Measured, not reasoned: a full re-walk on 2026-09-11 moved 702 company-1 lines
// PENDING -> READY (stock already in the warehouse, orders already released,
// some waiting over a year) and corrected 2 the other way.
//
// WHY A SOURCE SCAN. The handler is ~750 lines behind an optimistic-lock CAS, a
// lease, an AutoCount queue and a dropdown validator; standing all of that up to
// observe one best-effort call would test the scaffolding. What can be seen from
// outside, and is the thing that actually regressed, is the WIRING: that the
// handler calls the allocator at all, and that the call is gated on the field
// whose write opens the gate.
//
// WHAT IT CANNOT SEE, said rather than implied: that the call runs AFTER the
// header commits, and that it is reached on the success path. Those are read by
// a person. What it does catch is the regression that happened — the call being
// absent entirely — and a future edit that silently drops it.
//
// NO CONSTRUCTED REGEX. Every needle is asserted PRESENT before anything is
// asserted about it, because a matcher that escapes itself into matching nothing
// reports a clean run (CLAUDE.md: "a verdict computed over nothing must never
// read as a pass").
// ----------------------------------------------------------------------------
import { describe, expect, test } from 'vitest';
import soRoutesSrc from '../src/scm/routes/mfg-sales-orders.ts?raw';

/** Comments quote the shapes this file is about, so they are stripped. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SRC = code(soRoutesSrc);

/** The header PATCH handler's body, from its declaration to the next top-level
 *  route registration — the same slicing `poLineOrderWiring` uses. */
function headerHandler(): string {
  const at = SRC.indexOf('export const patchMfgSalesOrderHeaderHandler');
  if (at < 0) return '';
  const rest = SRC.slice(at);
  const end = rest.indexOf('\nmfgSalesOrders.');
  return end > 0 ? rest.slice(0, end) : rest;
}

describe('the header PATCH re-walks the allocator when it writes the gate', () => {
  test('the handler is still findable — the matcher is not stale', () => {
    expect(
      headerHandler().length,
      'patchMfgSalesOrderHeaderHandler was renamed or moved; every assertion below is computed over nothing until this is repointed',
    ).toBeGreaterThan(1000);
  });

  test('the handler still writes processing_date — otherwise this file guards nothing', () => {
    expect(
      headerHandler().includes("'processing_date'"),
      'the header PATCH no longer writes processing_date; if the gate moved, move this guard with it',
    ).toBe(true);
  });

  test('it calls the allocator', () => {
    expect(
      /recomputeSoStockAllocation\(/.test(headerHandler()),
      'the header PATCH does not re-walk the allocator — an order released by setting its processing date will sit PENDING with stock on the shelf, which is exactly the 702-line backlog of 2026-09-11',
    ).toBe(true);
  });

  test('the call is gated on processing_date, not fired on every header save', () => {
    const body = headerHandler();
    const at = body.search(/recomputeSoStockAllocation\(/);
    const window = body.slice(Math.max(0, at - 600), at);
    expect(
      /processing_date/.test(window),
      'the allocator call is not gated on processing_date — either it now runs on every header save (a full re-walk per keystroke-save), or the gate moved and this guard is reading the wrong thing',
    ).toBe(true);
  });

  test('the call is best-effort — a failed re-walk must not sink a saved header', () => {
    const body = headerHandler();
    const at = body.search(/recomputeSoStockAllocation\(/);
    const window = body.slice(Math.max(0, at - 200), at + 260);
    expect(
      /try\s*\{/.test(window) && /catch/.test(window),
      'the allocator call is not wrapped — the header CAS has already committed by this point, so a throw here reports failure for a save that succeeded',
    ).toBe(true);
  });
});
