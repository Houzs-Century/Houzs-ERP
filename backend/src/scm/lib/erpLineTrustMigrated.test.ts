/* A TYPED PRICE IS NOT THE SYSTEM'S TO CHANGE.
 *
 * Owner, 2026-09-02: 「我们的 selling price 是根据我们 manually 填入的，不应该被
 * 这种影响」 — the special-order surcharge, and the fabric surcharge with it, must
 * not move a price a person entered. On an AutoCount-imported line the stored
 * price IS that answer: it is the book's, and nothing here may recompute over it.
 *
 * The amendment path already said this, deriving 'including-zero' from
 * `linked_ac_docno IS NOT NULL`. The plain line PATCH passed a bare `true`, which
 * does NOT set `isMigratedTrust` — so on a migrated line priced 0, and 10,856 of
 * 13,909 migrated lines are priced 0, an ordinary edit could hand it
 * base + surcharges. Two edit paths, two answers about one order.
 *
 * These cases pin the four answers apart, because the modes are easy to confuse
 * and only one of them suppresses the chargeable-surcharge arm.
 */
import { describe, expect, it } from 'vitest';
import { erpLineTrust } from './mfg-pricing-recompute';

describe('erpLineTrust — the migrated marker', () => {
  it('a MIGRATED line trusts its stored price, zero included', () => {
    expect(erpLineTrust(false, 12345, undefined, true)).toBe('including-zero');
    expect(erpLineTrust(false, 0, undefined, true)).toBe('including-zero');
  });

  it('a native line keeps the old answers exactly', () => {
    expect(erpLineTrust(false, 12345, undefined, false)).toBe(true);
    expect(erpLineTrust(false, 0, undefined, false)).toBe(true);
    expect(erpLineTrust(false, 0, true, false)).toBe('operator-zero');
  });

  it('POS is never trusted, migrated or not — its 0 means "not provided"', () => {
    expect(erpLineTrust(true, 0, true, false)).toBe(false);
    expect(erpLineTrust(true, 0, true, true)).toBe(false);
    expect(erpLineTrust(true, 999, undefined, true)).toBe(false);
  });

  it('the migrated answer is NOT the same value as a native trusted one', () => {
    /* The whole point: only 'including-zero' switches off the chargeable
       surcharge arm. If these two ever compare equal the fix is gone. */
    expect(erpLineTrust(false, 0, undefined, true))
      .not.toBe(erpLineTrust(false, 0, undefined, false));
  });
});
