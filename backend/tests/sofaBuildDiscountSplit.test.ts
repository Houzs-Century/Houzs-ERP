import { describe, expect, test } from 'vitest';
import { distributeBuildDiscount, distributeProportionally } from '../src/scm/shared/so-sofa-split';

/* THE BUG THIS LOCKS DOWN — a discounted sofa build was INVOICED FOR MORE THAN
 * IT WAS ORDERED AT.
 *
 * A sofa line's discount is validated against the WHOLE BUILD's unit price
 * (mfg-sales-orders.ts create: `discI > qtyI * unitI` where unitI is the build
 * price). The build is then split into one row per module, and all three split
 * sites used to put the ENTIRE discount on module 0 — whose unit price is only
 * its own share. senOrZero (`Number.isFinite(v) ? v : 0`) passes negatives
 * straight through, so module 0's total_sen went negative.
 *
 * Every downstream document then CLAMPED that negative away —
 * `Math.max(0, (qty * unit) - discount)` at delivery-orders-mfg.ts:4016 (the
 * SO->DO convert), :3673, :4872 and sales-invoices.ts:374 — so the discount was
 * silently DELETED rather than carried. The SO said RM5,000 and the invoice said
 * RM6,000.
 *
 * Proof it was never intended: the SO's own item PATCH (mfg-sales-orders.ts:8439)
 * re-validates the discount against the MODULE's unit price and 422s
 * `invalid_discount` — so such a row could be created but not edited.
 *
 * The fix is distributeBuildDiscount. Plain proportional shares were NOT enough
 * and these tests are why: distributeProportionally floors every share and drops
 * the residue on the LAST entry, so at the top of the allowed discount range that
 * last share exceeds its own module's capacity and the row goes negative again —
 * by 1 sen instead of by RM1,000. The 'uneven module prices' case below caught
 * that, and the CODE changed rather than the assertion. distributeBuildDiscount
 * caps each share at its module's qty x unit and re-homes the excess.
 *
 * These tests assert the two properties that make that correct, because the
 * arithmetic is the whole fix:
 *   1. EXACT — the shares sum to the discount, so the header total (computed
 *      BEFORE the split) still equals the sum of the module rows.
 *   2. NEVER NEGATIVE — each share is <= that module's own qty x unit, which is
 *      exactly the invariant :8439 enforces on edit.
 */

/** The gate the create path applies before splitting. */
const discountAllowed = (qty: number, moduleUnits: number[], discount: number) =>
  discount >= 0 && discount <= qty * moduleUnits.reduce((a, b) => a + b, 0);

describe('sofa build discount split', () => {
  test('the reported case: 4 modules, RM8,000 build, RM3,000 discount', () => {
    const units = [200000, 200000, 200000, 200000]; // sen, RM2,000 each
    const qty = 1;
    const discount = 300000; // RM3,000 — allowed against the RM8,000 build
    expect(discountAllowed(qty, units, discount)).toBe(true);

    const shares = distributeBuildDiscount(discount, qty, units);

    // 1. exact
    expect(shares.reduce((a, b) => a + b, 0)).toBe(discount);
    // 2. no module row goes negative — the old code produced -100000 on module 0
    const totals = units.map((u, i) => qty * u - shares[i]!);
    expect(totals.every((t) => t >= 0)).toBe(true);
    // and the build still nets to the ordered amount, not the clamped one
    expect(totals.reduce((a, b) => a + b, 0)).toBe(qty * 800000 - discount);
  });

  test('the OLD placement is what produced the negative — kept as the counter-example', () => {
    const units = [200000, 200000, 200000, 200000];
    const qty = 1;
    const discount = 300000;
    const oldTotals = units.map((u, i) => qty * u - (i === 0 ? discount : 0));
    expect(oldTotals[0]).toBe(-100000);
    // What the DO/SI clamp then billed: the negative deleted, not carried.
    const clamped = oldTotals.map((t) => Math.max(0, t));
    expect(clamped.reduce((a, b) => a + b, 0)).toBe(600000); // RM6,000
    expect(clamped.reduce((a, b) => a + b, 0)).toBeGreaterThan(qty * 800000 - discount);
  });

  test('uneven module prices still never push a row negative', () => {
    // The dangerous shape: one cheap module and a discount most of the build.
    const units = [50000, 300000, 450000]; // RM500 / RM3,000 / RM4,500
    const qty = 2;
    const discount = qty * 800000 - 1; // just inside the gate
    expect(discountAllowed(qty, units, discount)).toBe(true);

    const shares = distributeBuildDiscount(discount, qty, units);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(discount);
    units.forEach((u, i) => expect(qty * u - shares[i]!).toBeGreaterThanOrEqual(0));
  });

  test('a zero discount leaves every module untouched', () => {
    const units = [100000, 100000];
    expect(distributeBuildDiscount(0, 1, units)).toEqual([0, 0]);
  });

  test('a single-module build takes the whole discount, exactly', () => {
    expect(distributeBuildDiscount(12345, 1, [500000])).toEqual([12345]);
  });

  test('all-zero module prices still distribute exactly rather than dividing by zero', () => {
    // distributeProportionally falls back to equal weights when the sum is 0.
    const shares = distributeProportionally(1000, [0, 0, 0]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });
});
