/* The Other Debtor bill print (owner 2026-09-18: 需要打印功能) — what it
   DRAWS, captured off `doc.text` the way deposit-invoice-pdf.test.ts does.
   Pinned: the title, the number and date, the debtor, the lines as
   description and amount (a blank description falls back to the account's
   name, the account code itself never prints), the debtor's address,
   attention, email and TIN in BILL TO (2026-09-21), the total, received and the
   balance due, the amount in words, the note, the status word, and a
   cancelled bill's watermark. Ordinary ASCII in the fixture: no CJK font
   fetch, no logo fetch, no network. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache, type Branding } from '../../../lib/branding';
import { billStatusWord, type DebtorBillPdfData } from './debtor-bill-pdf';

type JsPdf = import('jspdf').jsPDF;
type TextDraw = { text: string; y: number };
function captureTextDraws(doc: JsPdf): TextDraw[] {
  const draws: TextDraw[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value, , y] = args;
    if (typeof y === 'number') {
      const lines = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const line of lines) draws.push({ text: line.trim(), y });
    }
    return original(...args);
  }) as typeof doc.text);
  return draws;
}
const setUpBranding = (brand: Partial<Branding> = {}) => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '', ...brand }, 'HOUZS');
afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const BILL: DebtorBillPdfData = {
  bill: {
    id: 'b1', bill_number: 'HC-ODB-2609-001', bill_date: '2026-09-03', total_sen: 50000, received_sen: 20000, status: 'POSTED', notes: 'Sublet, September',
    lines: [
      { id: 'l1', line_no: 1, description: 'Sublet of showroom corner', credit_account_code: '570-0020', amount_sen: 45000 },
      { id: 'l2', line_no: 2, description: null, credit_account_code: '599-0006', amount_sen: 5000 },
      /* A text line (owner 2026-09-21): the description alone, no number, no amount. */
      { id: 'l3', line_no: 3, description: 'Ground floor, unit 3A', credit_account_code: null, amount_sen: 0 },
    ],
  },
  debtor: {
    name: 'AHMAD BIN ALI', phone: '012-345 6789', attention: 'MR AHMAD', email: 'ahmad@example.com', tin_number: 'IG12345678090',
    address1: '12, JALAN SATU', address2: 'TAMAN DUA', city: 'PETALING JAYA', postcode: '47810', state: 'Selangor', country: 'Malaysia',
  },
  accountName: (code) => (code === '599-0006' ? 'WATER & ELECTRICITY INCOME - OFFICE' : null),
};

async function render(over: Partial<DebtorBillPdfData['bill']> = {}, debtor: Partial<DebtorBillPdfData['debtor']> = {}, brand: Partial<Branding> = {}): Promise<TextDraw[]> {
  setUpBranding(brand);
  const [{ jsPDF }, autoTableModule, { renderDebtorBillInto }] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('./debtor-bill-pdf')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const draws = captureTextDraws(doc);
  await renderDebtorBillInto(doc, autoTableModule.default as unknown as (d: JsPdf, o: Record<string, unknown>) => void, { ...BILL, bill: { ...BILL.bill, ...over }, debtor: { ...BILL.debtor, ...debtor } });
  return draws;
}
const has = (draws: TextDraw[], needle: string): boolean => draws.some((d) => d.text.includes(needle));

describe('the Other Debtor bill sheet', () => {
  test('reads as an invoice to the debtor: number, date, the lines as description and amount, total, received, balance due, words, note', async () => {
    const draws = await render();
    expect(has(draws, 'INVOICE')).toBe(true);
    expect(has(draws, 'HC-ODB-2609-001')).toBe(true);
    expect(has(draws, '03/09/2026')).toBe(true);
    expect(has(draws, 'AHMAD BIN ALI')).toBe(true);
    expect(has(draws, '012-345 6789')).toBe(true);
    /* BILL TO carries the party's address as the registry holds it (owner 2026-09-21). */
    expect(has(draws, '12, JALAN SATU')).toBe(true);
    expect(has(draws, 'TAMAN DUA')).toBe(true);
    expect(has(draws, '47810 PETALING JAYA')).toBe(true);
    expect(has(draws, 'Selangor, Malaysia')).toBe(true);
    expect(has(draws, 'MR AHMAD')).toBe(true);
    expect(has(draws, 'ahmad@example.com')).toBe(true);
    expect(has(draws, 'IG12345678090')).toBe(true);
    expect(has(draws, 'Sublet of showroom corner')).toBe(true);
    expect(has(draws, 'MYR 450.00')).toBe(true);
    /* A blank description prints the account's name — never the code. */
    expect(has(draws, 'WATER & ELECTRICITY INCOME - OFFICE')).toBe(true);
    /* The text line prints its words and nothing else: no MYR 0.00, no third number. */
    expect(has(draws, 'Ground floor, unit 3A')).toBe(true);
    expect(has(draws, 'MYR 0.00')).toBe(false);
    expect(draws.some((d) => d.text === '3')).toBe(false);
    expect(has(draws, '599-0006')).toBe(false);
    expect(has(draws, '570-0020')).toBe(false);
    expect(has(draws, 'TOTAL')).toBe(true);
    expect(has(draws, 'MYR 500.00')).toBe(true);
    expect(has(draws, 'MYR 200.00')).toBe(true);
    expect(has(draws, 'BALANCE DUE')).toBe(true);
    expect(has(draws, 'MYR 300.00')).toBe(true);
    expect(has(draws, 'FIVE HUNDRED')).toBe(true);
    expect(has(draws, 'Sublet, September')).toBe(true);
    expect(has(draws, 'Partly paid')).toBe(true);
    expect(has(draws, 'Issued by')).toBe(true);
    expect(has(draws, 'CANCELLED')).toBe(false);
  });

  test('a cancelled bill wears the watermark; an unpaid one prints no received line', async () => {
    const cancelled = await render({ status: 'CANCELLED', received_sen: 0 });
    expect(has(cancelled, 'CANCELLED')).toBe(true);
    expect(has(cancelled, 'Cancelled')).toBe(true);
    expect(has(cancelled, 'BALANCE DUE')).toBe(false);
  });

  test('a debtor with no address on file prints the name and phone alone — no empty address labels', async () => {
    const draws = await render({}, { attention: null, email: null, tin_number: null, address1: null, address2: null, city: null, postcode: null, state: null, country: null });
    expect(has(draws, 'AHMAD BIN ALI')).toBe(true);
    expect(has(draws, '012-345 6789')).toBe(true);
    expect(draws.some((d) => d.text === 'Address')).toBe(false);
    expect(draws.some((d) => d.text === 'Attention' || d.text === 'Email' || d.text === 'TIN')).toBe(false);
  });

  test("the foot carries the company's payment details and terms for a party outside the trade — the debtor's set, never the customer's; blank prints nothing (owner 2026-09-21)", async () => {
    const draws = await render({}, {}, {
      debtorPaymentDetails: `Maybank 5644 1875 9397
HOUZS CENTURY SDN BHD`,
      debtorInvoiceTerms: 'Payment within 14 days of the invoice date.\nCheques payable to HOUZS CENTURY SDN BHD.',
      customerPaymentDetails: 'CIMB 8000 1234 5678',
    });
    expect(has(draws, 'PAYMENT DETAILS')).toBe(true);
    expect(has(draws, 'Maybank 5644 1875 9397')).toBe(true);
    expect(has(draws, 'HOUZS CENTURY SDN BHD')).toBe(true);
    expect(has(draws, 'CIMB 8000 1234 5678')).toBe(false);
    expect(has(draws, 'TERMS & CONDITIONS')).toBe(true);
    expect(has(draws, '1. Payment within 14 days of the invoice date.')).toBe(true);
    expect(has(draws, '2. Cheques payable to HOUZS CENTURY SDN BHD.')).toBe(true);
    /* The blocks sit above the signature boxes. */
    const y = (needle: string) => draws.find((d) => d.text.includes(needle))!.y;
    expect(y('PAYMENT DETAILS')).toBeLessThan(y('TERMS & CONDITIONS'));
    expect(y('TERMS & CONDITIONS')).toBeLessThan(y('Issued by'));

    const bare = await render({}, {}, { customerPaymentDetails: 'CIMB 8000 1234 5678' });
    expect(has(bare, 'PAYMENT DETAILS')).toBe(false);
    expect(has(bare, 'TERMS & CONDITIONS')).toBe(false);
  });

  test('the status word follows the money', () => {
    expect(billStatusWord({ status: 'POSTED', total_sen: 50000, received_sen: 0 })).toBe('Unpaid');
    expect(billStatusWord({ status: 'POSTED', total_sen: 50000, received_sen: 20000 })).toBe('Partly paid');
    expect(billStatusWord({ status: 'PAID', total_sen: 50000, received_sen: 50000 })).toBe('Paid');
    expect(billStatusWord({ status: 'CANCELLED', total_sen: 50000, received_sen: 0 })).toBe('Cancelled');
  });
});
