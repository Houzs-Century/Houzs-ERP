/* The A4 RECEIPT (the owner's Claude Design, batch 5 §9; no print existed
   before) — a sundry receipt and an other debtor's receipt, captured off
   `doc.text`. Pinned: RECEIPT with its number and date; RECEIVED FROM beside
   RECEIPT DETAILS; the lines without our accounts; AMOUNT RECEIVED; the
   words; Received by and the chop; VOID on a voided receipt; an other
   debtor's `Payment for invoice <bill> · <what for>`, `Written at approval`
   and DRAFT until it is approved. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import { sundryReceiptPaper, type SundryReceiptPdfData } from './sundry-receipt-pdf';
import { debtorReceiptPaper, type DebtorReceiptPdfData } from './debtor-receipt-pdf';
import type { A4ReceiptPaper } from './receipt-a4-pdf';

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
afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const NAMES = new Map([['310-0001', 'Hong Leong Bank'], ['700-0000', 'Other Income']]);
const nameOf = (code: string): string | null => NAMES.get(code) ?? null;

async function render(paper: A4ReceiptPaper): Promise<TextDraw[]> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, autoTable, { renderA4ReceiptInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable').then((m) => m.default), import('./receipt-a4-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const draws = captureTextDraws(doc);
  await renderA4ReceiptInto(doc, autoTable as unknown as Parameters<typeof renderA4ReceiptInto>[1], paper);
  return draws;
}
const has = (draws: TextDraw[], needle: string): boolean => draws.some((d) => d.text.includes(needle));

const SUNDRY: SundryReceiptPdfData = {
  receipt: { receipt_number: 'HC-RCT-2610-004', payer_name: 'Booth refund — MLE', receipt_date: '2026-10-05', bank_account_code: '310-0001', total_sen: 88_800, status: 'POSTED', notes: 'Refund of the September booth' },
  lines: [
    { description: 'Deposit returned', credit_account_code: '700-0000', amount_sen: 80_000 },
    { description: null, credit_account_code: '700-0000', amount_sen: 8_800 },
  ],
  accountName: nameOf,
  journalNo: 'HC-JE-2610-0912',
};
const DEBTOR: DebtorReceiptPdfData = {
  receipt: { receipt_number: '2990-ODR-2610-001', receipt_date: '2026-10-03', bank_account_code: '310-0001', total_sen: 60_000, status: 'DRAFT', submitted_at: '2026-10-03T01:00:00Z', checked_at: null, notes: '[rejected] Wrong bank\nSeptember rental' },
  debtor: { name: 'AHMAD BIN ALI', phone: '012-345', address1: '12 Jalan Satu', city: 'Petaling Jaya', postcode: '46000', email: 'ahmad@example.com', business_reg_no: '202001012345' },
  bills: [
    { billNumber: '2990-ODB-2609-001', description: 'September sublet', amountSen: 50_000 },
    { billNumber: '2990-ODB-2609-002', description: null, amountSen: 10_000 },
  ],
  accountName: nameOf,
};

describe('a sundry receipt on paper', () => {
  test('who paid, the receipt, the money account and journal; the lines without our accounts; AMOUNT RECEIVED in figures and words', async () => {
    const draws = await render(sundryReceiptPaper(SUNDRY));
    expect(has(draws, 'RECEIPT')).toBe(true);
    expect(has(draws, 'Receipt No: HC-RCT-2610-004')).toBe(true);
    expect(has(draws, 'RECEIVED FROM')).toBe(true);
    expect(has(draws, 'Booth refund — MLE')).toBe(true);
    expect(has(draws, 'RECEIPT DETAILS')).toBe(true);
    expect(has(draws, ': 310-0001 Hong Leong Bank')).toBe(true);
    expect(has(draws, ': HC-JE-2610-0912')).toBe(true);
    expect(has(draws, ': Posted')).toBe(true);
    expect(has(draws, 'Deposit returned')).toBe(true);
    /* A line with no words reads as its account's name — never its code. */
    expect(has(draws, 'Other Income')).toBe(true);
    expect(has(draws, '700-0000')).toBe(false);
    expect(has(draws, 'AMOUNT RECEIVED')).toBe(true);
    expect(has(draws, 'RM 888.00')).toBe(true);
    expect(has(draws, 'RINGGIT MALAYSIA EIGHT HUNDRED')).toBe(true);
    expect(has(draws, 'Refund of the September booth')).toBe(true);
    expect(has(draws, 'Received by')).toBe(true);
    expect(has(draws, 'VOID')).toBe(false);
  });

  test('a voided receipt prints VOID', async () => {
    const draws = await render(sundryReceiptPaper({ ...SUNDRY, receipt: { ...SUNDRY.receipt, status: 'CANCELLED' } }));
    expect(draws.some((d) => d.text === 'VOID')).toBe(true);
    expect(has(draws, ': Voided')).toBe(true);
  });
});

describe("an other debtor's receipt on paper", () => {
  test('the debtor as the registry holds them; a line per bill; Written at approval; DRAFT until approved; no rejection on the paper', async () => {
    const draws = await render(debtorReceiptPaper(DEBTOR));
    expect(has(draws, 'AHMAD BIN ALI')).toBe(true);
    expect(has(draws, '12 Jalan Satu')).toBe(true);
    expect(has(draws, '46000 Petaling Jaya')).toBe(true);
    expect(has(draws, '202001012345')).toBe(true);
    expect(has(draws, ': Written at approval')).toBe(true);
    expect(has(draws, ': Prepared')).toBe(true);
    expect(has(draws, 'Payment for invoice 2990-ODB-2609-001')).toBe(true);
    expect(has(draws, 'Payment for invoice 2990-ODB-2609-002')).toBe(true);
    expect(has(draws, 'RM 600.00')).toBe(true);
    expect(has(draws, 'September rental')).toBe(true);
    expect(has(draws, 'Wrong bank')).toBe(false);
    expect(draws.some((d) => d.text === 'DRAFT')).toBe(true);
  });

  test('approved: no watermark, its journal named; voided: VOID', async () => {
    const approved = await render(debtorReceiptPaper({ ...DEBTOR, receipt: { ...DEBTOR.receipt, status: 'POSTED', checked_at: 'x' }, journalNo: '2990-JE-2610-0101' }));
    expect(approved.some((d) => d.text === 'DRAFT')).toBe(false);
    expect(has(approved, ': 2990-JE-2610-0101')).toBe(true);
    expect(has(approved, ': Approved')).toBe(true);
    const voided = await render(debtorReceiptPaper({ ...DEBTOR, receipt: { ...DEBTOR.receipt, status: 'CANCELLED' } }));
    expect(voided.some((d) => d.text === 'VOID')).toBe(true);
    expect(voided.some((d) => d.text === 'DRAFT')).toBe(false);
  });
});
