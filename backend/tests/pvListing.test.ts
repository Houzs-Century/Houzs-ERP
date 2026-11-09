/* The Payment listing and the bank a voucher pays into (owner 2026-11-08:
   「pv notes 我不想要全部挤在一排，然后把notes 换成description」, 「每天要过账的listing，
   就算pv号码，名字，description, purpose，包含bank account number」, 「我能自己filter 吗？」,
   「purpose 可以」). Pinned, on the real handlers and a fake PostgREST:
     • the listing: the stages asked (by default Prepared and Checked, not yet posted),
       dated up to the day asked (and from the day asked, when one is), oldest first,
       never another company's; a stage it does not know, or a range the wrong way
       round, is refused;
     • purpose: the payment requests a voucher answers, by number; else what its lines
       say, once each;
     • the bank it pays into: its own three fields; a voucher made before them reads its
       request's bank, else its supplier's;
     • the list of vouchers carries the same, and a new voucher keeps the bank it is given. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { listPaymentVouchersHandler } from '../src/scm/routes/payment-vouchers-list';
import { paymentListingHandler } from '../src/scm/routes/payment-vouchers-listing';
import { payToFields, payToUpdates } from '../src/scm/routes/payment-vouchers-describe';

const CO = 1;
const PV = (over: Row): Row => ({
  company_id: CO, status: 'DRAFT', submitted_at: null, checked_at: null, supplier_id: null, supplier: null, notes: null,
  total_sen: 10_000, credit_account_code: '310-0010', currency: 'MYR', purpose: 'OTHER', bill_ref: null,
  pay_to_bank_name: null, pay_to_account_no: null, pay_to_account_name: null, ...over,
});
const tables = (): Record<string, Row[]> => ({
  payment_vouchers: [
    PV({ id: 'd1', pv_number: 'HC-Draft-2611-001', payee_name: 'TNB', voucher_date: '2026-11-01', notes: 'Electricity October' }),
    PV({
      id: 'p1', pv_number: 'HC-Draft-2611-002', payee_name: 'MK PROPERTIES', voucher_date: '2026-11-02', submitted_at: 'x', notes: 'Booth deposit',
      pay_to_bank_name: 'MAYBANK', pay_to_account_no: '5140 1234 5678', pay_to_account_name: 'MK PROPERTIES SDN BHD',
    }),
    PV({
      id: 'c1', pv_number: 'HC-HPV-2611-001', payee_name: 'KIAN FURNITURE', voucher_date: '2026-11-03', submitted_at: 'x', checked_at: 'y',
      supplier_id: 'sup-k', purpose: 'SUPPLIER_PAYMENT',
      supplier: { id: 'sup-k', code: '400-K001', name: 'KIAN FURNITURE SDN BHD', bank_name: 'PUBLIC BANK', bank_account_no: '3188 0000 11', bank_account_name: 'KIAN FURNITURE SDN BHD' },
    }),
    PV({ id: 'c2', pv_number: 'HC-HPV-2611-002', payee_name: 'MELVIN CHONG', voucher_date: '2026-11-04', submitted_at: 'x', checked_at: 'y', purpose: 'CUSTOMER_REFUND' }),
    PV({ id: 'c3', pv_number: 'HC-HPV-2611-003', payee_name: 'LATER CO', voucher_date: '2026-11-09', submitted_at: 'x', checked_at: 'y' }),
    PV({ id: 'a1', pv_number: 'HC-HPV-2610-009', payee_name: 'FOSHAN CHAIRS', voucher_date: '2026-10-05', status: 'POSTED' }),
    PV({ id: 'x1', pv_number: 'HC-HPV-2609-003', payee_name: 'OLD CO', voucher_date: '2026-09-03', status: 'CANCELLED' }),
    /* Another company's: never listed. */
    PV({ id: 'z9', pv_number: '2990-HPV-2611-001', payee_name: 'TNB', voucher_date: '2026-11-01', submitted_at: 'x', company_id: 2 }),
  ],
  payment_voucher_lines: [
    { company_id: CO, pv_id: 'p1', line_no: 1, description: 'BOOTH DEPOSIT IOI CITY' },
    { company_id: CO, pv_id: 'p1', line_no: 2, description: 'BOOTH DEPOSIT IOI CITY' },
    { company_id: CO, pv_id: 'c1', line_no: 1, description: 'SOFA STOCK OCTOBER' },
    { company_id: CO, pv_id: 'c2', line_no: 1, description: 'REFUND' },
  ],
  acc_payment_requests: [
    {
      company_id: CO, pv_id: 'c2', request_no: 'HC-PRQ-2610-030', purpose: 'Refund of deposit, order cancelled',
      bank_name: 'CIMB', bank_account_no: '7000 1111 22', bank_account_name: 'MELVIN CHONG',
    },
  ],
  acc_supplier_advances: [],
  journal_entries: [],
});
const app = (t = tables()) => {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fakeSb(t) as never);
    c.set('companyId' as never, CO as never);
    await next();
  });
  a.get('/payment-vouchers/listing', paymentListingHandler as never);
  a.get('/payment-vouchers', listPaymentVouchersHandler as never);
  return a;
};
type Listing = { vouchers: Row[]; from: string | null; to: string; stages: string[] };
const listing = async (qs: string): Promise<Listing> => {
  const res = await app().request(`/payment-vouchers/listing${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Listing;
};
const nos = (r: { vouchers: Row[] }) => r.vouchers.map((v) => v.pv_number);
const byNo = async (qs: string) => new Map((await listing(qs)).vouchers.map((v) => [String(v.pv_number), v]));
const bank = (v: Row | undefined) => [v?.pay_bank, v?.pay_account_no, v?.pay_account_name];

describe('the Payment listing', () => {
  test('by default what is not yet posted, Prepared and Checked, dated up to the day, oldest first', async () => {
    const r = await listing('?to=2026-11-08');
    expect(r.stages).toEqual(['PREPARED', 'CHECKED']);
    expect(r.from).toBeNull();
    expect(nos(r)).toEqual(['HC-Draft-2611-002', 'HC-HPV-2611-001', 'HC-HPV-2611-002']);
    expect(r.vouchers.map((v) => v.stage)).toEqual(['PREPARED', 'CHECKED', 'CHECKED']);
  });

  test('the stages and the dates asked, and never another company\'s', async () => {
    expect(nos(await listing('?to=2026-11-08&stages=POSTED,CANCELLED'))).toEqual(['HC-HPV-2609-003', 'HC-HPV-2610-009']);
    expect(nos(await listing('?from=2026-11-03&to=2026-11-30&stages=CHECKED'))).toEqual(['HC-HPV-2611-001', 'HC-HPV-2611-002', 'HC-HPV-2611-003']);
    expect(nos(await listing('?to=2026-11-08&stages=DRAFT'))).toEqual(['HC-Draft-2611-001']);
  });

  test('a stage it does not know, or a range the wrong way round, is refused', async () => {
    expect((await app().request('/payment-vouchers/listing?stages=PAID')).status).toBe(400);
    expect((await app().request('/payment-vouchers/listing?from=2026-11-09&to=2026-11-01')).status).toBe(400);
  });

  test('purpose: the request it answers, by number; else what its lines say, once each', async () => {
    const v = await byNo('?to=2026-11-08');
    expect(v.get('HC-HPV-2611-002')!.purpose_text).toBe('HC-PRQ-2610-030 Refund of deposit, order cancelled');
    expect(v.get('HC-Draft-2611-002')!.purpose_text).toBe('BOOTH DEPOSIT IOI CITY');
    expect(v.get('HC-HPV-2611-001')!.purpose_text).toBe('SOFA STOCK OCTOBER');
  });

  test('the bank it pays into: its own; else its request\'s; else its supplier\'s', async () => {
    const v = await byNo('?to=2026-11-08');
    expect(bank(v.get('HC-Draft-2611-002'))).toEqual(['MAYBANK', '5140 1234 5678', 'MK PROPERTIES SDN BHD']);
    expect(bank(v.get('HC-HPV-2611-002'))).toEqual(['CIMB', '7000 1111 22', 'MELVIN CHONG']);
    expect(bank(v.get('HC-HPV-2611-001'))).toEqual(['PUBLIC BANK', '3188 0000 11', 'KIAN FURNITURE SDN BHD']);
  });

  test('the list of vouchers carries the same purpose and bank', async () => {
    const res = await app().request('/payment-vouchers');
    const rows = (await res.json() as { paymentVouchers: Row[] }).paymentVouchers;
    const c2 = rows.find((v) => v.pv_number === 'HC-HPV-2611-002')!;
    expect([c2.purpose_text, ...bank(c2)]).toEqual(['HC-PRQ-2610-030 Refund of deposit, order cancelled', 'CIMB', '7000 1111 22', 'MELVIN CHONG']);
  });
});

describe('the bank a voucher is given', () => {
  test('a new voucher keeps the three fields, trimmed, blank as nothing', () => {
    expect(payToFields({ payToBankName: ' MAYBANK ', payToAccountNo: '5140 1234 5678', payToAccountName: '' })).toEqual({
      pay_to_bank_name: 'MAYBANK', pay_to_account_no: '5140 1234 5678', pay_to_account_name: null,
    });
    expect(payToFields({})).toEqual({ pay_to_bank_name: null, pay_to_account_no: null, pay_to_account_name: null });
  });

  test('an edit changes only the fields it sends', () => {
    expect(payToUpdates({ payToAccountNo: ' 7000 1111 22 ' })).toEqual({ pay_to_account_no: '7000 1111 22' });
    expect(payToUpdates({ payToBankName: null })).toEqual({ pay_to_bank_name: null });
    expect(payToUpdates({ notes: 'x' })).toEqual({});
  });
});
