import { describe, expect, test } from 'vitest';
import { soPaidCenti, soBalanceCenti, soOutstandingCenti, soPaidInputsOf } from './so-outstanding';

/* WHICH COLUMN is the load-bearing half of this module, not the arithmetic.
   `balance_centi` is the one that looks like the answer — the cutover's own
   UDF_BALANCE landed in it and `recomputeTotals` then overwrote it with the
   gross total — so a reader that picked it would be wrong in a way no unit test
   of the arithmetic could catch. */
describe('the columns the rule reads off a mfg_sales_orders row', () => {
  test('the total comes from total_revenue_centi, and balance_centi is ignored', () => {
    const inputs = soPaidInputsOf(
      { total_revenue_centi: 500_00, balance_centi: 999_00, deposit_centi: 100_00 },
      0, false,
    );
    expect(inputs.totalRevenueCenti).toBe(500_00);
    expect(inputs.headerDepositCenti).toBe(100_00);
    expect(soBalanceCenti(inputs)).toBe(400_00);
  });

  test('an absent or non-numeric column reads as 0 rather than NaN', () => {
    expect(soPaidInputsOf({}, 0, false)).toEqual({
      totalRevenueCenti: 0, headerDepositCenti: 0, ledgerPaidCenti: 0, depositInLedger: false,
    });
    expect(soPaidInputsOf({ total_revenue_centi: null, deposit_centi: '5' }, 0, false).totalRevenueCenti)
      .toBe(0);
    expect(soPaidInputsOf(null, 0, false).headerDepositCenti).toBe(0);
  });
});

/* The rule GET /mfg-sales-orders/:docNo has always applied, now shared with the
   AutoCount write-back so the account book and the SO detail page cannot show
   different numbers. These cases are the reason it is a function and not two
   expressions. */
describe('what a sales order still owes', () => {
  const base = {
    totalRevenueCenti: 500_00,
    headerDepositCenti: 0,
    ledgerPaidCenti: 0,
    depositInLedger: false,
  };

  test('nothing paid means the whole total is outstanding', () => {
    expect(soBalanceCenti(base)).toBe(500_00);
    expect(soPaidCenti(base)).toBe(0);
  });

  test('the payments ledger is the paid amount', () => {
    expect(soBalanceCenti({ ...base, ledgerPaidCenti: 200_00 })).toBe(300_00);
  });

  /* The one case that needs a rule rather than a sum. Since the SO create path
     writes the deposit as an is_deposit ledger row, adding the header column on
     top would double count every modern order; leaving it out would under-count
     the legacy ones that never reached the ledger. */
  test('a legacy header deposit counts — the ledger has no is_deposit row for it', () => {
    expect(soPaidCenti({ ...base, headerDepositCenti: 150_00, ledgerPaidCenti: 50_00 }))
      .toBe(200_00);
  });

  test('the same deposit does NOT count twice once it is in the ledger', () => {
    expect(soPaidCenti({
      ...base, headerDepositCenti: 150_00, ledgerPaidCenti: 150_00, depositInLedger: true,
    })).toBe(150_00);
  });

  /* CHANGED 2026-08-16, owner's ruling 「需要可以超收 negative 边红色」. This
     used to assert `an overpaid order is 0, never negative`, on the reasoning
     that a licensed ledger is no place to invent a negative — while noting, in
     the same comment, that AutoCount's own UDF_BALANCE holds negatives on 47 of
     the extract's 13,015 headers. The book could always say it; only the ERP
     could not, so the ERP refused the money and an operator put RM 250 of cash
     into a line price instead. The BALANCE is now signed; the floored figure
     that aggregates and gates read is `soOutstandingCenti`, right below. */
  test('an overpaid order reads NEGATIVE — that is the credit', () => {
    expect(soBalanceCenti({ ...base, ledgerPaidCenti: 900_00 })).toBe(-400_00);
  });

  test('the RECEIVABLE stays floored at 0, so no aggregate absorbs the credit', () => {
    expect(soOutstandingCenti({ ...base, ledgerPaidCenti: 900_00 })).toBe(0);
  });

  test('a zero-total order owes nothing', () => {
    expect(soBalanceCenti({ ...base, totalRevenueCenti: 0 })).toBe(0);
  });
});
