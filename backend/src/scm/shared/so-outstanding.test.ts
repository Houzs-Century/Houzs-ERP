import { describe, expect, test } from 'vitest';
import { soPaidCenti, soOutstandingCenti } from './so-outstanding';

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
    expect(soOutstandingCenti(base)).toBe(500_00);
    expect(soPaidCenti(base)).toBe(0);
  });

  test('the payments ledger is the paid amount', () => {
    expect(soOutstandingCenti({ ...base, ledgerPaidCenti: 200_00 })).toBe(300_00);
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

  /* An overpayment is a credit, and `getCustomerCreditBalance` is where the ERP
     keeps that. Both the view (GREATEST) and the detail route (Math.max) clamp,
     so the write-back does too rather than inventing a negative balance in a
     licensed ledger — note that AutoCount's own UDF_BALANCE DOES hold negatives
     on 47 of the extract's 13,015 headers, and the ERP has no way to say that. */
  test('an overpaid order is 0, never negative', () => {
    expect(soOutstandingCenti({ ...base, ledgerPaidCenti: 900_00 })).toBe(0);
  });

  test('a zero-total order owes nothing', () => {
    expect(soOutstandingCenti({ ...base, totalRevenueCenti: 0 })).toBe(0);
  });
});
