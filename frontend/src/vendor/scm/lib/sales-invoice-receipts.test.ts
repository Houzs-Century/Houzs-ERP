/* The Sales Invoice print's "Payments received" (owner 2026-10-06: the print
   called every sum taken on the order "Deposit (<order>)", even money that
   paid it in full — 2990-SO-2606-036, Tan Yee Heng). Pinned: one line per sum,
   day · method · where, when the rows add up to what settles the invoice; one
   line per document when they do not; nothing when nothing was received; the
   word "Deposit" nowhere on the paper. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import { paymentsReceivedLines, type SiHeader, type SiItem } from './sales-invoice-pdf';

const ITEMS: SiItem[] = [{ item_code: 'SKU-A', description: 'Sofa', qty: 1, unit_price_sen: 336_500, line_total_sen: 336_500 }];
const SI: SiHeader = {
  invoice_number: '2990-SI-2609-045', status: 'SENT', so_doc_no: '2990-SO-2606-036', debtor_code: null, debtor_name: 'Tan Yee Heng',
  invoice_date: '2026-07-18', due_date: null, currency: 'MYR', subtotal_sen: 336_500, discount_sen: 0, tax_sen: 0, total_sen: 336_500,
  paid_sen: 0, notes: null,
};

describe('the payments received, as the invoice prints them', () => {
  test('paid in full on the order: one line — the day, how, on which order; no "Deposit"', () => {
    const lines = paymentsReceivedLines({ ...SI, so_deposit_applied_sen: 336_500,
      receipts: { order: [{ paid_at: '2026-06-20', method: 'installment', amount_sen: 336_500 }], invoice: [] } });
    expect(lines).toEqual([{ label: '2026/06/20 · Installment · on order 2990-SO-2606-036', amountSen: 336_500 }]);
  });

  test('a deposit on the order and the balance on the invoice: a line each, the order first', () => {
    const lines = paymentsReceivedLines({ ...SI, paid_sen: 236_500, so_deposit_applied_sen: 100_000,
      receipts: {
        order: [{ paid_at: '2026-06-15', method: 'cash', amount_sen: 100_000 }],
        invoice: [{ paid_at: '2026-07-20', method: 'transfer', amount_sen: 236_500 }],
      } });
    expect(lines).toEqual([
      { label: '2026/06/15 · Cash · on order 2990-SO-2606-036', amountSen: 100_000 },
      { label: '2026/07/20 · Bank transfer / DuitNow · on this invoice', amountSen: 236_500 },
    ]);
  });

  test('nothing received: no lines — the Outstanding line carries the whole total', () => {
    expect(paymentsReceivedLines({ ...SI, so_deposit_applied_sen: 0, receipts: { order: [], invoice: [] } })).toEqual([]);
  });

  test('an order split over several invoices: its rows are not this invoice\'s, so one line with the share', () => {
    const lines = paymentsReceivedLines({ ...SI, so_deposit_applied_sen: 200_000,
      receipts: { order: [{ paid_at: '2026-06-15', method: 'cash', amount_sen: 500_000 }], invoice: [] } });
    expect(lines).toEqual([{ label: 'Paid on order 2990-SO-2606-036', amountSen: 200_000 }]);
  });

  test('a header without the rows (an older caller) still says where the money was taken — never "Deposit"', () => {
    const lines = paymentsReceivedLines({ ...SI, paid_sen: 36_500, so_deposit_applied_sen: 300_000 });
    expect(lines).toEqual([
      { label: 'Paid on order 2990-SO-2606-036', amountSen: 300_000 },
      { label: 'Paid on this invoice', amountSen: 36_500 },
    ]);
  });

  test('money brought over from AutoCount is a payment; money moved from another order says so', () => {
    const lines = paymentsReceivedLines({ ...SI, so_deposit_applied_sen: 336_500,
      receipts: { order: [
        { paid_at: '2025-11-16', method: 'imported', amount_sen: 136_500 },
        { paid_at: '2026-06-20', method: 'converted', amount_sen: 200_000 },
      ], invoice: [] } });
    expect(lines.map((l) => l.label)).toEqual([
      '2025/11/16 · Payment · on order 2990-SO-2606-036',
      '2026/06/20 · Moved from another order · on order 2990-SO-2606-036',
    ]);
  });
});

describe('the printed page', () => {
  afterEach(() => {
    setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
    clearBrandingLogoCache();
    vi.restoreAllMocks();
  });

  test('draws "Payments received" between the GRAND TOTAL and the Outstanding, and never the word Deposit', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, autoTable, { renderSalesInvoiceInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable').then((m) => m.default), import('./sales-invoice-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const draws: Array<{ text: string; y: number }> = [];
    const original = doc.text.bind(doc);
    vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
      const [value, , y] = args;
      if (typeof y === 'number') for (const line of Array.isArray(value) ? value : [value]) draws.push({ text: String(line).trim(), y });
      return original(...args);
    }) as typeof doc.text);
    await renderSalesInvoiceInto(doc, autoTable, { ...SI, so_deposit_applied_sen: 100_000,
      receipts: { order: [{ paid_at: '2026-06-15', method: 'cash', amount_sen: 100_000 }], invoice: [] } },
    ITEMS);
    const y = (needle: string) => draws.find((d) => d.text.includes(needle))!.y;
    expect(y('Payments received')).toBeGreaterThan(y('GRAND TOTAL'));
    expect(y('2026/06/15 · Cash · on order 2990-SO-2606-036')).toBeGreaterThan(y('Payments received'));
    expect(y('Outstanding')).toBeGreaterThan(y('2026/06/15 · Cash'));
    expect(draws.some((d) => d.text.includes('RM 2,365.00'))).toBe(true);
    expect(draws.some((d) => /deposit/i.test(d.text))).toBe(false);
  });
});
