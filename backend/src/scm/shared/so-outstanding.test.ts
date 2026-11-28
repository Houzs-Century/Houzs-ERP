import { describe, expect, test } from 'vitest';
import {
  soPaidSen, soOutstandingSen, soPaidInputsOf, soBalanceSen, soDisplayTotalSen,
} from './so-outstanding';

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
      totalRevenueSen: 0, localTotalSen: 0, headerDepositSen: 0,
      ledgerPaidSen: 0, depositInLedger: false,
    });
    expect(soPaidInputsOf({ total_revenue_sen: null, deposit_sen: '5' }, 0, false).totalRevenueSen)
      .toBe(0);
    expect(soPaidInputsOf(null, 0, false).headerDepositSen).toBe(0);
  });

  test('local_total_sen is read too — a migrated order has no other total', () => {
    const inputs = soPaidInputsOf(
      { local_total_sen: 3_200_00, total_revenue_sen: 0, balance_sen: 1_600_00 },
      1_600_00, true,
    );
    expect(inputs.localTotalSen).toBe(3_200_00);
    expect(inputs.totalRevenueSen).toBe(0);
  });
});

/* THE OWNER'S SALES ORDER, 2026-09-08: Total RM 3,200.00, Paid RM 1,600.00,
   Balance RM 0.00 on his phone — while the SO LIST beside it, reading the
   view's `balance_sen_live` (= local_total - payments), said RM 1,600.00. */
describe('the total a human is shown, when only one column has been filled', () => {
  const migrated = {
    totalRevenueSen: 0,
    localTotalSen: 3_200_00,
    headerDepositSen: 0,
    ledgerPaidSen: 1_600_00,
    depositInLedger: true,
  };

  test('a recomputed order still answers off total_revenue_sen', () => {
    expect(soDisplayTotalSen({ ...migrated, totalRevenueSen: 4_000_00 })).toBe(4_000_00);
  });

  test('a migrated order falls back to local_total_sen', () => {
    expect(soDisplayTotalSen(migrated)).toBe(3_200_00);
  });

  test('and its balance is the money still owed, not 0', () => {
    expect(soBalanceSen(migrated)).toBe(1_600_00);
  });

  test('a fully-paid migrated order is still 0 — the fallback is not a floor', () => {
    expect(soBalanceSen({ ...migrated, ledgerPaidSen: 3_200_00 })).toBe(0);
  });

  test('an over-collected migrated order goes negative, not clamped to 0', () => {
    expect(soBalanceSen({ ...migrated, ledgerPaidSen: 4_000_00 })).toBe(-800_00);
  });

  test('an order with no total at all still answers 0', () => {
    expect(soBalanceSen({ ...migrated, localTotalSen: 0 })).toBe(0);
  });

  /* The write-back's rule is deliberately untouched by the fallback, and this
     pins that it did not move — the screen changed, the licensed ledger's rule
     did not.

     THE 0 HERE IS NEVER ASKED FOR ANY MORE, which is the follow-up this comment
     used to promise. `readSoOutstandingSen` (scm/lib/autocount-read.ts) now
     REFUSES a `total_revenue_sen` that is not greater than zero, so the account
     book is told nothing at all about a migrated order rather than being told
     this 0. The arithmetic below is unchanged on purpose: the fix belongs in
     the reader, which is where the decision "may the ERP speak" lives.
     docs/bugs/0726-*. */
  test('the write-back rule does NOT fall back — a migrated order stays 0 there', () => {
    expect(soOutstandingSen(migrated)).toBe(0);
  });
});

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

  test('a legacy header deposit counts — the ledger has no is_deposit row for it', () => {
    expect(soPaidSen({ ...base, headerDepositSen: 150_00, ledgerPaidSen: 50_00 }))
      .toBe(200_00);
  });

  test('the same deposit does NOT count twice once it is in the ledger', () => {
    expect(soPaidSen({
      ...base, headerDepositSen: 150_00, ledgerPaidSen: 150_00, depositInLedger: true,
    })).toBe(150_00);
  });

  test('an overpaid order is 0, never negative', () => {
    expect(soOutstandingSen({ ...base, ledgerPaidSen: 900_00 })).toBe(0);
  });

  test('a zero-total order owes nothing', () => {
    expect(soOutstandingSen({ ...base, totalRevenueSen: 0 })).toBe(0);
  });
});
