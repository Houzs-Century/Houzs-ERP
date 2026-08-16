import { describe, expect, test } from 'vitest';
import { soBalanceOf, soReceivableOf, soOverCollectedOf } from './so-balance';

/* The owner's ruling, 2026-08-16: 「需要可以超收 negative 边红色」 — an
   over-collection is legal, the balance goes negative, and the negative shows
   in red. These cases are that ruling, plus the one production fact that stops
   it being a one-line unfloor. */
describe('soBalanceOf — the signed balance', () => {
  test('an unpaid order owes its whole total', () => {
    expect(soBalanceOf(400_00, 0)).toBe(400_00);
  });

  test('a part-paid order owes the remainder', () => {
    expect(soBalanceOf(400_00, 200_00)).toBe(200_00);
  });

  test('a settled order owes nothing', () => {
    expect(soBalanceOf(400_00, 400_00)).toBe(0);
  });

  /* HC-SO-2608-002, the order this fix exists for: RM 4,000 of goods, RM 2,000
     already banked, and the operator collects RM 2,250 more. Before this rule
     the system refused the payment, so the money was booked by raising a line
     price to RM 250 instead — RM 250 of cash recorded as item value. */
  test('an over-collected order reads NEGATIVE — that is the credit', () => {
    expect(soBalanceOf(400_00, 425_00)).toBe(-25_00);
  });

  /* THE GUARD THAT MAKES THE UNFLOOR SAFE. Measured on production 2026-08-16
     (probe-so-overpay.mjs, run 31938486974): 2,739 of 2,824 non-cancelled SOs
     carry total_revenue_centi = 0, and 2,121 of them are owed money the detail
     page already shows as RM 0.00. Subtracting the ledger from a zero total
     would paint every one of them as an over-collection — HC-SO-012075 alone
     would read -RM 9,900 while genuinely owing RM 22,988. A total of 0 is
     "unknown", not "worth nothing", so no credit is claimed. */
  test('a zero or missing total NEVER produces a credit', () => {
    expect(soBalanceOf(0, 99_00)).toBe(0);
    expect(soBalanceOf(0, 0)).toBe(0);
  });

  test('a negative total (bad data) is floored too, never amplified', () => {
    expect(soBalanceOf(-100_00, 0)).toBe(0);
  });

  test('sen stay integers — no float creeps in', () => {
    expect(Number.isInteger(soBalanceOf(1_23, 4_56))).toBe(true);
    expect(soBalanceOf(1_23, 4_56)).toBe(-333);
  });
});

/* An aggregate and a screen want different answers, and conflating them is how
   one customer's overpayment silently pays down someone else's debt. */
describe('soReceivableOf — what is still collectable', () => {
  test('matches the balance while money is owed', () => {
    expect(soReceivableOf(400_00, 200_00)).toBe(200_00);
  });

  test('an over-collected order contributes ZERO to a receivable, not a credit', () => {
    expect(soReceivableOf(400_00, 425_00)).toBe(0);
  });
});

describe('soOverCollectedOf — the excess', () => {
  test('is 0 while the order is owed money', () => {
    expect(soOverCollectedOf(400_00, 200_00)).toBe(0);
  });

  test('is the excess once the order is over-collected', () => {
    expect(soOverCollectedOf(400_00, 425_00)).toBe(25_00);
  });

  test('is 0 when the total is unknown, for the same reason the balance is', () => {
    expect(soOverCollectedOf(0, 99_00)).toBe(0);
  });
});
