/**
 * The two decisions in the restored PO pull that a wrong answer makes
 * expensive and silent.
 *
 * 1. `isCancelled` — AutoCount reports Cancelled as the STRING "T"/"F" on some
 *    endpoints and a real boolean on others. A naive truthiness check reads
 *    "F" as cancelled=true (non-empty string), which would mark every live PO
 *    cancelled; reading only `=== true` misses the string form and marks every
 *    cancelled PO live. Both directions corrupt the Finance roll-up, and
 *    neither throws.
 *
 * 2. `deriveLineAmount` — the outstanding-commitment figure. The rule is
 *    local currency first (the P&L is in RM), then foreign, and only then the
 *    computed unit × remaining-qty fallback. Returning null when nothing is
 *    derivable is a REQUIREMENT, not a gap: a null is a visible hole somebody
 *    fills in, a wrong number silently becomes a cost figure.
 */
import { describe, expect, it } from 'vitest';
import { isCancelled } from './acSnapshot';
import { deriveLineAmount } from './po';

describe('isCancelled', () => {
  it('reads AutoCount\'s string flags', () => {
    expect(isCancelled('T')).toBe(true);
    expect(isCancelled('t')).toBe(true);
    expect(isCancelled('true')).toBe(true);
    // The trap: "F" is a non-empty string and therefore truthy in JS.
    expect(isCancelled('F')).toBe(false);
    expect(isCancelled('f')).toBe(false);
    expect(isCancelled('false')).toBe(false);
  });

  it('reads the boolean and numeric shapes', () => {
    expect(isCancelled(true)).toBe(true);
    expect(isCancelled(1)).toBe(true);
    expect(isCancelled('1')).toBe(true);
    expect(isCancelled(false)).toBe(false);
    expect(isCancelled(0)).toBe(false);
  });

  it('treats absent as not cancelled', () => {
    expect(isCancelled(null)).toBe(false);
    expect(isCancelled(undefined)).toBe(false);
    expect(isCancelled('')).toBe(false);
    expect(isCancelled('  ')).toBe(false);
  });
});

describe('deriveLineAmount', () => {
  it('prefers the local-currency line total', () => {
    expect(
      deriveLineAmount({ LocalSubTotal: 1200, SubTotal: 250, UnitPrice: 10, RemainingQty: 3 })
    ).toBe(1200);
  });

  it('falls back to the ex-tax local total before any foreign figure', () => {
    expect(deriveLineAmount({ LocalSubTotalExTax: 900, SubTotal: 250 })).toBe(900);
  });

  it('uses the foreign total only when no local one exists', () => {
    expect(deriveLineAmount({ SubTotal: 250, UnitPrice: 10, RemainingQty: 3 })).toBe(250);
  });

  it('computes unit x outstanding qty when the middleware returns no totals', () => {
    // This is the shape the current middleware actually returns — the whole
    // reason the fallback exists.
    expect(deriveLineAmount({ UnitPriceAfterDiscount: 80, RemainingQty: 4 })).toBe(320);
    expect(deriveLineAmount({ UnitPrice: 80, RemainingQty: 4 })).toBe(320);
  });

  it('prefers the after-discount unit price over the list price', () => {
    expect(deriveLineAmount({ UnitPrice: 100, UnitPriceAfterDiscount: 80, RemainingQty: 2 })).toBe(160);
  });

  it('returns null rather than inventing a number', () => {
    expect(deriveLineAmount({})).toBeNull();
    expect(deriveLineAmount({ UnitPrice: 80 })).toBeNull();
    expect(deriveLineAmount({ RemainingQty: 4 })).toBeNull();
    // Non-finite money must never reach the roll-up as a value.
    expect(deriveLineAmount({ LocalSubTotal: NaN, SubTotal: Infinity })).toBeNull();
    expect(deriveLineAmount({ LocalSubTotal: '1200' as unknown as number })).toBeNull();
  });

  it('keeps a genuine zero distinct from "unknown"', () => {
    // A free-of-charge line really is 0; that is data, not a missing value.
    expect(deriveLineAmount({ LocalSubTotal: 0 })).toBe(0);
  });
});
