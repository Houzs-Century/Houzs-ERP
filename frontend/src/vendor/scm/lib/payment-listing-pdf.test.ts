/* The Payment listing on paper (owner 2026-11-08: 每天要过账的 listing). Pinned: the
   cells and the total read without a PDF — the Amount in RM, totalled, and a voucher
   in another currency printing its own amount under the ringgit; and, on the real
   jsPDF, one landscape listing delivered by the action asked. Ordinary ASCII: no
   font fetch, no network. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { jsPDF } from 'jspdf';

const deliver = vi.fn();
vi.mock('./pdf-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pdf-common')>();
  return { ...real, deliverPdf: (...args: unknown[]) => deliver(...args) };
});

import { generatePaymentListingPdf, paymentListingTable, type PaymentListingView } from './payment-listing-pdf';
import { fmtMoneySen, todayMY } from '../../shared/format';

afterEach(() => { deliver.mockClear(); });

const VIEW: PaymentListingView = {
  keys: ['pv_number', 'voucher_date', 'payee', 'bank', 'accountNo', 'amount', 'stage'],
  matrix: {
    header: ['PV No.', 'Date', 'Payee', 'Bank', 'Account no.', 'Amount (RM)', 'Stage'],
    formats: ['text', 'date', 'text', 'text', 'text', 'money', 'text'],
    body: [
      ['HC-HPV-2611-001', '2026-11-03', 'TNB', null, null, 320.5, 'Checked'],
      ['HC-HPV-2611-002', '2026-11-04', 'FOSHAN CHAIRS', 'BANK OF CHINA', '6217 0000', 650, 'Checked'],
    ],
  },
  rows: [{ currency: 'MYR', total_sen: 32_050 }, { currency: 'RMB', total_sen: 100_000 }],
};

describe('the Payment listing on paper', () => {
  test('the Amount in RM, totalled; a voucher in another currency prints its own amount under the ringgit', () => {
    const t = paymentListingTable(VIEW);
    expect(t.head).toEqual(VIEW.matrix.header);
    expect(t.body[0]).toEqual(['HC-HPV-2611-001', '2026/11/03', 'TNB', '-', '-', '320.50', 'Checked']);
    expect(t.body[1]![5]).toBe(`650.00\n${fmtMoneySen(100_000, 'RMB')}`);
    expect(t.totalSen).toBe(97_050);
    expect(t.foot).toEqual([{ content: 'Total (2 rows)', colSpan: 5 }, '970.50', { content: '', colSpan: 1 }]);
  });

  test('a listing printed without its Amount column prints as it is', () => {
    const t = paymentListingTable({ ...VIEW, keys: VIEW.keys.map((k) => (k === 'amount' ? 'other' : k)) });
    expect(t.body[1]![5]).toBe('650.00');
  });

  test('one landscape listing, delivered by the action asked', async () => {
    await generatePaymentListingPdf(VIEW, { subtitle: 'Vouchers dated up to 2026/11/08, at Checked.', action: 'print' });
    expect(deliver).toHaveBeenCalledTimes(1);
    const [doc, name, action] = deliver.mock.calls[0]! as [jsPDF, string, string];
    expect(name).toBe(`payment-listing-${todayMY()}.pdf`);
    expect(action).toBe('print');
    expect(doc.internal.pageSize.getWidth()).toBeGreaterThan(doc.internal.pageSize.getHeight());
  });
});
