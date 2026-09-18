/* The Other Debtor bill print (owner 2026-09-18: 需要打印功能) — what it
   DRAWS, captured off `doc.text` the way deposit-invoice-pdf.test.ts does.
   Pinned: the title, the number and date, the debtor, the lines as
   description and amount (a blank description falls back to the account's
   name, the account code itself never prints), the total, received and the
   balance due, the amount in words, the note, the status word, and a
   cancelled bill's watermark. Ordinary ASCII in the fixture: no CJK font
   fetch, no logo fetch, no network. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
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
const setUpBranding = () => setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
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
    ],
  },
  debtor: { name: 'AHMAD BIN ALI', phone: '012-345 6789' },
  accountName: (code) => (code === '599-0006' ? 'WATER & ELECTRICITY INCOME - OFFICE' : null),
};

async function render(over: Partial<DebtorBillPdfData['bill']> = {}): Promise<TextDraw[]> {
  setUpBranding();
  const [{ jsPDF }, autoTableModule, { renderDebtorBillInto }] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('./debtor-bill-pdf')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const draws = captureTextDraws(doc);
  await renderDebtorBillInto(doc, autoTableModule.default as unknown as (d: JsPdf, o: Record<string, unknown>) => void, { ...BILL, bill: { ...BILL.bill, ...over } });
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
    expect(has(draws, 'Sublet of showroom corner')).toBe(true);
    expect(has(draws, 'MYR 450.00')).toBe(true);
    /* A blank description prints the account's name — never the code. */
    expect(has(draws, 'WATER & ELECTRICITY INCOME - OFFICE')).toBe(true);
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

  test('the status word follows the money', () => {
    expect(billStatusWord({ status: 'POSTED', total_sen: 50000, received_sen: 0 })).toBe('Unpaid');
    expect(billStatusWord({ status: 'POSTED', total_sen: 50000, received_sen: 20000 })).toBe('Partly paid');
    expect(billStatusWord({ status: 'PAID', total_sen: 50000, received_sen: 50000 })).toBe('Paid');
    expect(billStatusWord({ status: 'CANCELLED', total_sen: 50000, received_sen: 0 })).toBe('Cancelled');
  });
});
