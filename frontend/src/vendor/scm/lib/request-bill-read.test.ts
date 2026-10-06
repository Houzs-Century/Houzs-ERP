/* The payment request filled from the paper (owner 2026-10-02: upload 后很多资料
   都没有填; 自动填了资料还能手动改). Pinned:
     • an empty form takes every field the bill printed — who to pay, the amount
       (the bill's total), the due date, what it is for, the payee's bank;
     • what the requester typed is never replaced;
     • a later read (a phone adds the bill page by page) replaces only what the
       earlier read put there and nobody touched;
     • a field the bill did not print offers nothing. */

import { describe, expect, test } from 'vitest';
import { billOffer, fillFromBill, filledFromBill } from './request-bill-read';
import type { PaymentRequestInput } from './payment-request-queries';

const EMPTY: PaymentRequestInput = {
  payeeName: '', amountSen: 0, dueDate: null, purpose: '', projectId: null, bankName: null, bankAccountNo: null, bankAccountName: null,
};
const BILL = {
  billNo: 'HV-INV-202608-0051', billDate: '2026-08-31', totalSen: 808_233, vendorName: 'HOUZS VENTURE HOLDINGS SDN BHD',
  dueDate: '2026-09-30', summary: "Payroll cost share — Aug'26 · adjustment",
  bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd',
};

describe('the request filled from the bill', () => {
  test('an empty form takes every field the bill printed', () => {
    const offer = billOffer(BILL);
    const form = fillFromBill(EMPTY, offer);
    expect(form).toEqual({
      payeeName: 'HOUZS VENTURE HOLDINGS SDN BHD', amountSen: 808_233, dueDate: '2026-09-30', purpose: "Payroll cost share — Aug'26 · adjustment",
      projectId: null, bankName: 'Hong Leong Bank Berhad', bankAccountNo: '123-4567-8901', bankAccountName: 'Houzs Venture Holding Sdn Bhd',
    });
    expect(filledFromBill(form, offer)).toEqual(['payeeName', 'amountSen', 'dueDate', 'purpose', 'bankName', 'bankAccountNo', 'bankAccountName']);
  });

  test('what the requester typed is never replaced, and a field they change is no longer the bill\'s', () => {
    const typed = { ...EMPTY, payeeName: 'Houzs Venture Holding Sdn Bhd', amountSen: 400_000, purpose: 'HC share of Aug payroll' };
    const offer = billOffer(BILL);
    const form = fillFromBill(typed, offer);
    expect(form).toMatchObject({ payeeName: 'Houzs Venture Holding Sdn Bhd', amountSen: 400_000, purpose: 'HC share of Aug payroll', dueDate: '2026-09-30', bankName: 'Hong Leong Bank Berhad' });
    expect(filledFromBill(form, offer)).toEqual(['dueDate', 'bankName', 'bankAccountNo', 'bankAccountName']);
    expect(filledFromBill({ ...form, bankAccountNo: '123-4567-8902' }, offer)).toEqual(['dueDate', 'bankName', 'bankAccountName']);
  });

  test('a later read replaces only what the earlier one put there and nobody touched', () => {
    const page1 = billOffer({ ...BILL, totalSen: null, dueDate: null, bankName: null, bankAccountNo: null, bankAccountName: null, summary: 'Payroll cost share' });
    const afterPage1 = fillFromBill(EMPTY, page1);
    expect(afterPage1).toMatchObject({ payeeName: 'HOUZS VENTURE HOLDINGS SDN BHD', amountSen: 0, purpose: 'Payroll cost share', bankAccountNo: null });
    /* They touch the purpose; the second page reads more. */
    const touched = { ...afterPage1, purpose: 'HC share of Aug payroll' };
    const page2 = billOffer({ ...BILL, vendorName: 'Houzs Venture Holdings' });
    const afterPage2 = fillFromBill(touched, page2, page1);
    expect(afterPage2).toMatchObject({
      payeeName: 'Houzs Venture Holdings',          // untouched — follows the newer read
      purpose: 'HC share of Aug payroll',           // typed — stays
      amountSen: 808_233, dueDate: '2026-09-30', bankAccountNo: '123-4567-8901', // empty — filled
    });
  });

  test('nothing printed offers nothing — no RM 0.00 amount, no blank bank', () => {
    expect(billOffer({ billNo: null, billDate: null, totalSen: 0, vendorName: '  ' })).toEqual({});
    expect(billOffer(null)).toEqual({});
    expect(fillFromBill(EMPTY, {})).toBe(EMPTY);
  });
});
