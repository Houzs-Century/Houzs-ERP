/* The Deposit Invoice print (docs/bugs/0834) — what it DRAWS, captured off
   `doc.text` the way payment-voucher-pdf.test.ts does. Since 2026-10-06 it is
   A4 in the Sales Invoice's layout (owner: print 出来不好看). Pinned: the
   title, the number and date, the customer with the order's address, phone
   and e-mail, the sales order and how it was paid, the one line and the
   amount in figures and in words, where the order stands (its total, paid to
   date, balance), the credit note that closed it, and a cancelled invoice's
   watermark and reason. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { formatPhone } from '@2990s/shared/phone';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache, type Branding } from '../../../lib/branding';
import type { DepositInvoicePdfData } from './deposit-invoice-pdf';

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

const DI: DepositInvoicePdfData = {
  di_number: '2990-DI-2609-001', status: 'ISSUED', invoice_date: '2026-09-05',
  party_name: 'Larding Chen', party_code: 'cust-larding', so_doc_no: '2990-SO-2609-001',
  method: 'cash', amount_sen: 100000, je_no: '2990-JE-2609-0011', credit_note_number: null, cancel_reason: null,
};
const ORDER: NonNullable<DepositInvoicePdfData['order']> = {
  address1: 'No. 12, Jalan Contoh 3', address2: 'Taman Contoh', postcode: '47300', city: 'Petaling Jaya', customer_state: 'Selangor',
  phone: '0123456789', email: 'larding@example.com', total_sen: 336_500, paid_to_date_sen: 136_500,
};

async function render(over: Partial<DepositInvoicePdfData> = {}, brand: Partial<Branding> = {}): Promise<{ draws: TextDraw[]; doc: JsPdf }> {
  setUpBranding(brand);
  const [{ jsPDF }, autoTable, { renderDepositInvoiceInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable').then((m) => m.default), import('./deposit-invoice-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const draws = captureTextDraws(doc);
  await renderDepositInvoiceInto(doc, autoTable, { ...DI, ...over });
  return { draws, doc };
}
const has = (draws: TextDraw[], needle: string): boolean => draws.some((d) => d.text.includes(needle));

describe("the customer's payment details (owner 2026-09-21)", () => {
  test("prints the customer set from Settings › Branding above the signature boxes — not the other debtor's; blank prints nothing", async () => {
    const { draws } = await render({}, { customerPaymentDetails: 'CIMB 8000 1234 5678\n2990 HOME SDN BHD', debtorPaymentDetails: 'Maybank 5644 1875 9397' });
    expect(has(draws, 'PAYMENT DETAILS')).toBe(true);
    expect(has(draws, 'CIMB 8000 1234 5678')).toBe(true);
    expect(has(draws, '2990 HOME SDN BHD')).toBe(true);
    expect(has(draws, 'Maybank 5644 1875 9397')).toBe(false);
    const y = (needle: string) => draws.find((d) => d.text.includes(needle))!.y;
    expect(y('PAYMENT DETAILS')).toBeLessThan(y('Issued by'));
    const { draws: bare } = await render({}, { debtorPaymentDetails: 'Maybank 5644 1875 9397' });
    expect(has(bare, 'PAYMENT DETAILS')).toBe(false);
  });
});

describe('the deposit invoice sheet — A4, the Sales Invoice layout (owner 2026-10-06)', () => {
  test('says what it is, for whom, against which order, how it was paid, and how much — in a line, in figures and in words', async () => {
    const { draws, doc } = await render();
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(210, 0);
    expect(has(draws, 'DEPOSIT INVOICE')).toBe(true);
    expect(has(draws, '2990-DI-2609-001')).toBe(true);
    expect(has(draws, 'BILL TO')).toBe(true);
    expect(has(draws, 'Larding Chen')).toBe(true);
    expect(has(draws, 'cust-larding')).toBe(true);
    expect(has(draws, 'DEPOSIT DETAILS')).toBe(true);
    expect(has(draws, ': 2990-SO-2609-001')).toBe(true);
    expect(has(draws, ': Cash')).toBe(true);
    expect(has(draws, ': Issued')).toBe(true);
    expect(has(draws, 'Deposit received for Sales Order 2990-SO-2609-001')).toBe(true);
    expect(has(draws, 'DEPOSIT TOTAL')).toBe(true);
    expect(has(draws, 'RM 1,000.00')).toBe(true);
    expect(has(draws, 'ONE THOUSAND')).toBe(true);
    expect(has(draws, 'deducted from the final invoice of sales order 2990-SO-2609-001')).toBe(true);
    expect(has(draws, 'Issued by')).toBe(true);
    expect(has(draws, 'Page 1 of 1')).toBe(true);
    expect(has(draws, 'CANCELLED')).toBe(false);
    expect(has(draws, 'Closed by')).toBe(false);
    /* No order on the sheet: nothing about it is guessed. */
    expect(has(draws, 'Order total')).toBe(false);
    expect(has(draws, 'Balance on order')).toBe(false);
  });

  test("with its order: the customer's address, phone and e-mail, and where the order stands after this deposit", async () => {
    const { draws } = await render({ order: ORDER });
    /* The address wraps to the column; read back in order it is the order's lines, composed as the SO print composes them. */
    expect(draws.map((d) => d.text).join(' ')).toContain('No. 12, Jalan Contoh 3, Taman Contoh, 47300 Petaling Jaya Selangor');
    expect(has(draws, formatPhone('0123456789'))).toBe(true);
    expect(has(draws, 'larding@example.com')).toBe(true);
    expect(has(draws, 'Order total')).toBe(true);
    expect(has(draws, 'RM 3,365.00')).toBe(true);
    expect(has(draws, 'Paid to date (this order)')).toBe(true);
    expect(has(draws, 'RM 1,365.00')).toBe(true);
    expect(has(draws, 'Balance on order')).toBe(true);
    expect(has(draws, 'RM 2,000.00')).toBe(true);
  });

  test("a customer id is no code to print (2990 keys its customers by uuid)", async () => {
    const { draws } = await render({ party_code: '9061e023-0ad0-4504-a59d-ba2cc41dd4f2' });
    expect(has(draws, '9061e023')).toBe(false);
    expect(has(draws, 'Larding Chen')).toBe(true);
  });

  test('names the credit note that closed it', async () => {
    const { draws } = await render({ credit_note_number: '2990-CN-2609-003' });
    expect(has(draws, ': Credit note 2990-CN-2609-003')).toBe(true);
  });

  test('a cancelled invoice reads as void, with its reason', async () => {
    const { draws } = await render({ status: 'CANCELLED', cancel_reason: 'payment on 2990-SO-2609-001 edited — re-issued' });
    expect(has(draws, 'CANCELLED')).toBe(true);
    expect(has(draws, ': Cancelled')).toBe(true);
    expect(has(draws, 'Cancelled: payment on 2990-SO-2609-001 edited')).toBe(true);
  });
});
