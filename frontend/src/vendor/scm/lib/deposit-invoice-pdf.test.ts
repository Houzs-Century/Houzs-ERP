/* The Deposit Invoice print (docs/bugs/0834) — what it DRAWS, captured off
   `doc.text` the way payment-voucher-pdf.test.ts does. Pinned: the title, the
   number and date, the customer, the sales order and how it was paid, the
   amount in figures and in words, the credit note that closed it, and a
   cancelled invoice's watermark and reason. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
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
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
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

async function render(over: Partial<DepositInvoicePdfData> = {}): Promise<TextDraw[]> {
  setUpBranding();
  const [{ jsPDF }, { renderDepositInvoiceInto }] = await Promise.all([import('jspdf'), import('./deposit-invoice-pdf')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });
  const draws = captureTextDraws(doc);
  renderDepositInvoiceInto(doc, { ...DI, ...over });
  return draws;
}
const has = (draws: TextDraw[], needle: string): boolean => draws.some((d) => d.text.includes(needle));

describe('the deposit invoice sheet', () => {
  test('says what it is, for whom, against which order, how it was paid, and how much — in figures and in words', async () => {
    const draws = await render();
    expect(has(draws, 'DEPOSIT INVOICE')).toBe(true);
    expect(has(draws, '2990-DI-2609-001')).toBe(true);
    expect(has(draws, 'Larding Chen')).toBe(true);
    expect(has(draws, 'Customer code: cust-larding')).toBe(true);
    expect(has(draws, 'Sales order: 2990-SO-2609-001')).toBe(true);
    expect(has(draws, 'Paid by: Cash')).toBe(true);
    expect(has(draws, 'Amount: MYR 1,000.00')).toBe(true);
    expect(has(draws, 'ONE THOUSAND')).toBe(true);
    expect(has(draws, 'Issued by')).toBe(true);
    expect(has(draws, 'CANCELLED')).toBe(false);
    expect(has(draws, 'Closed by credit note')).toBe(false);
  });

  test('names the credit note that closed it', async () => {
    const draws = await render({ credit_note_number: '2990-CN-2609-003' });
    expect(has(draws, 'Closed by credit note 2990-CN-2609-003')).toBe(true);
  });

  test('a cancelled invoice reads as void, with its reason', async () => {
    const draws = await render({ status: 'CANCELLED', cancel_reason: 'payment on 2990-SO-2609-001 edited — re-issued' });
    expect(has(draws, 'CANCELLED')).toBe(true);
    expect(has(draws, 'Cancelled: payment on 2990-SO-2609-001 edited')).toBe(true);
  });
});
