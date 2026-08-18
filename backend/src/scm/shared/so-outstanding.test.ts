import { describe, expect, test } from 'vitest';
import { soPaidSen, soOutstandingSen, soPaidInputsOf } from './so-outstanding';

/* WHICH COLUMN is the load-bearing half of this module, not the arithmetic.
   `balance_sen` is the one that looks like the answer — the cutover's own
   UDF_BALANCE landed in it and `recomputeTotals` then overwrote it with the
   gross total — so a reader that picked it would be wrong in a way no unit test
   of the arithmetic could catch. */
describe('the columns the rule reads off a mfg_sales_orders row', () => {
  test('the total comes from total_revenue_sen, and balance_sen is ignored', () => {
    const inputs = soPaidInputsOf(
      { total_revenue_sen: 500_00, balance_sen: 999_00, deposit_sen: 100_00 },
      0, false,
    );
    expect(inputs.totalRevenueSen).toBe(500_00);
    expect(inputs.headerDepositSen).toBe(100_00);
    expect(soOutstandingSen(inputs)).toBe(400_00);
  });

  test('an absent or non-numeric column reads as 0 rather than NaN', () => {
    expect(soPaidInputsOf({}, 0, false)).toEqual({
      totalRevenueSen: 0, headerDepositSen: 0, ledgerPaidSen: 0, depositInLedger: false,
    });
    expect(soPaidInputsOf({ total_revenue_sen: null, deposit_sen: '5' }, 0, false).totalRevenueSen)
      .toBe(0);
    expect(soPaidInputsOf(null, 0, false).headerDepositSen).toBe(0);
  });
});

/* The rule GET /mfg-sales-orders/:docNo has always applied, now shared with the
   AutoCount write-back so the account book and the SO detail page cannot show
   different numbers. These cases are the reason it is a function and not two
   expressions. */
describe('what a sales order still owes', () => {
  const base = {
    totalRevenueSen: 500_00,
    headerDepositSen: 0,
    ledgerPaidSen: 0,
    depositInLedger: false,
  };

  test('nothing paid means the whole total is outstanding', () => {
    expect(soOutstandingSen(base)).toBe(500_00);
    expect(soPaidSen(base)).toBe(0);
  });

  test('the payments ledger is the paid amount', () => {
    expect(soOutstandingSen({ ...base, ledgerPaidSen: 200_00 })).toBe(300_00);
  });

  /* The one case that needs a rule rather than a sum. Since the SO create path
     writes the deposit as an is_deposit ledger row, adding the header column on
     top would double count every modern order; leaving it out would under-count
     the legacy ones that never reached the ledger. */
  test('a legacy header deposit counts — the ledger has no is_deposit row for it', () => {
    expect(soPaidSen({ ...base, headerDepositSen: 150_00, ledgerPaidSen: 50_00 }))
      .toBe(200_00);
  });

  test('the same deposit does NOT count twice once it is in the ledger', () => {
    expect(soPaidSen({
      ...base, headerDepositSen: 150_00, ledgerPaidSen: 150_00, depositInLedger: true,
    })).toBe(150_00);
  });

  /* An overpayment is a credit, and `getCustomerCreditBalance` is where the ERP
     keeps that. Both the view (GREATEST) and the detail route (Math.max) clamp,
     so the write-back does too rather than inventing a negative balance in a
     licensed ledger — note that AutoCount's own UDF_BALANCE DOES hold negatives
     on 47 of the extract's 13,015 headers, and the ERP has no way to say that. */
  test('an overpaid order is 0, never negative', () => {
    expect(soOutstandingSen({ ...base, ledgerPaidSen: 900_00 })).toBe(0);
  });

  test('a zero-total order owes nothing', () => {
    expect(soOutstandingSen({ ...base, totalRevenueSen: 0 })).toBe(0);
  });
});
