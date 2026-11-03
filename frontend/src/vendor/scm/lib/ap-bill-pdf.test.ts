/* The AP BILL print (Money out › Supplier bills, batch 4 step 8). Pinned off
   the page as data (apBillSheet), then off the drawn page the way
   credit-note-pdf.test.ts reads it:
     • the heading is the paper's — AP BILL, or SUPPLIER DEBIT NOTE with its
       own date and reference labels;
     • the supplier with the control it sits on (the code, the name below);
       the supplier's invoice no., the due date, what is outstanding, the
       journal, the description;
     • each line's account as the owner reads it — code, then name below —
       its description and amount; the TOTAL in figures and words;
     • who raised, posted or cancelled it;
     • a Draft and a Cancelled bill carry the design's band; a posted one none.
   Ordinary ASCII in the fixture: no CJK font fetch, no logo fetch, no network. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import { apBillSheet, type ApBillPdfData } from './ap-bill-pdf';

const BILL: ApBillPdfData = {
  invoice: {
    invoice_number: '2990-API-2609-001', doc_kind: 'INV', status: 'PARTIALLY_PAID',
    invoice_date: '2026-09-01', due_date: '2026-09-30', supplier_invoice_ref: 'HVH-0912',
    currency: 'MYR', total_sen: 420_000, paid_sen: 100_000, notes: 'Rent September',
    je_no: '2990-JE-2609-0030',
    created_at: '2026-09-01T02:00:00Z', created_by: 'Nico',
    posted_at: '2026-09-02T03:30:00Z', posted_by: 'Daniel',
    cancelled_at: null, cancelled_by: null,
  },
  lines: [
    { description: 'Rent Sept', debit_account_code: '900-A001', amount_sen: 400_000 },
    { description: null, debit_account_code: '900-Z999', amount_sen: 20_000 },
  ],
  supplier: { code: '405-H001', name: 'HOUZS VENTURE HOLDING SDN BHD' },
  controlCode: '405-0000',
};
const nameOf = (code: string) => ({ '900-A001': 'RENTAL', '405-0000': 'OTHER CREDITORS' } as Record<string, string>)[code] ?? null;
const bill = (over: Partial<ApBillPdfData['invoice']> = {}): ApBillPdfData => ({ ...BILL, invoice: { ...BILL.invoice, ...over } });

describe('the AP BILL page as data', () => {
  test('a posted bill: heading, number and date, the supplier and its control, the facts, the lines, the total in words, the stamps, no band', () => {
    const s = apBillSheet(BILL, nameOf);
    expect(s.title).toBe('AP BILL');
    expect(s.meta).toEqual([{ label: 'No', value: '2990-API-2609-001' }, { label: 'Invoice date', value: '2026/09/01' }]);
    expect(s.band).toBeNull();
    expect(s.supplier).toEqual({ name: 'HOUZS VENTURE HOLDING SDN BHD', lines: ['405-H001 · Control 405-0000', 'OTHER CREDITORS'] });
    expect(s.factsTitle).toBe('BILL DETAILS');
    expect(s.facts).toEqual([
      ['Supplier’s invoice no.', 'HVH-0912'],
      ['Due date', '2026/09/30'],
      ['Outstanding', 'RM 3,200.00'],
      ['Journal', '2990-JE-2609-0030'],
      ['Description', 'Rent September'],
    ]);
    expect(s.head).toEqual(['Account', 'Description', 'Amount (RM)']);
    /* The account as the owner reads it — the code, its name below; an unknown code still prints as itself. */
    expect(s.body).toEqual([
      ['900-A001\nRENTAL', 'Rent Sept', 'RM 4,000.00'],
      ['900-Z999', '—', 'RM 200.00'],
    ]);
    expect(s.total).toBe('RM 4,200.00');
    expect(s.words).toBe('RINGGIT MALAYSIA FOUR THOUSAND TWO HUNDRED ONLY');
    expect(s.stamp).toBe('Created by Nico 2026/09/01 10:00 · Posted by Daniel 2026/09/02 11:30');
  });

  test('a draft says it is not on the books: its band, no outstanding, the journal still to be written', () => {
    const s = apBillSheet(bill({ status: 'DRAFT', paid_sen: 0, je_no: null, posted_at: null, posted_by: null }), nameOf);
    expect(s.band).toEqual({ text: 'DRAFT · not posted to the ledger', tone: 'draft' });
    expect(s.facts).toContainEqual(['Outstanding', '—']);
    expect(s.facts).toContainEqual(['Journal', 'Written when posted']);
    expect(s.stamp).toBe('Created by Nico 2026/09/01 10:00');
  });

  test('a stamp that keeps an account id, not a name, says when only — an id never prints as a person', () => {
    const s = apBillSheet(bill({ created_by: '6b1f0c9e-4a2d-4c1b-9f00-1a2b3c4d5e6f', posted_by: '' }), nameOf);
    expect(s.stamp).toBe('Created 2026/09/01 10:00 · Posted 2026/09/02 11:30');
  });

  test('a cancelled bill: reversed when it had posted, never posted when it had not', () => {
    const reversed = apBillSheet(bill({ status: 'CANCELLED', paid_sen: 0, cancelled_at: '2026-09-05T01:00:00Z', cancelled_by: 'Nico' }), nameOf);
    expect(reversed.band).toEqual({ text: 'CANCELLED · its journal was reversed', tone: 'cancelled' });
    expect(reversed.facts).toContainEqual(['Outstanding', '—']);
    expect(reversed.stamp).toContain('Cancelled by Nico 2026/09/05 09:00');
    const never = apBillSheet(bill({ status: 'CANCELLED', paid_sen: 0, je_no: null, posted_at: null }), nameOf);
    expect(never.band).toEqual({ text: 'CANCELLED · never posted', tone: 'cancelled' });
    expect(never.facts).toContainEqual(['Journal', 'Never posted']);
  });

  test('a supplier debit note prints under its own heading and labels; no description, no row for it', () => {
    const s = apBillSheet(bill({ doc_kind: 'DN', invoice_number: '2990SDN-2610-001', notes: null, supplier_invoice_ref: null }), nameOf);
    expect(s.title).toBe('SUPPLIER DEBIT NOTE');
    expect(s.meta[1]).toEqual({ label: 'Note date', value: '2026/09/01' });
    expect(s.factsTitle).toBe('NOTE DETAILS');
    expect(s.facts[0]).toEqual(['Supplier’s debit note no.', '—']);
    expect(s.facts.some(([label]) => label === 'Description')).toBe(false);
  });

  test('a supplier the chart cannot name, and no control, still print what is known', () => {
    const s = apBillSheet({ ...BILL, supplier: { code: null, name: null }, controlCode: null }, nameOf);
    expect(s.supplier).toEqual({ name: '—', lines: [] });
  });
});

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

describe('the drawn AP BILL', () => {
  test('draws the heading, the band, the supplier, the lines, the total, the words and its own page count', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, { default: autoTable }, { renderApBillInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('./ap-bill-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    /* A page already in the doc: the bill counts its own pages, not the file's. */
    doc.text('previous document', 20, 20);
    doc.addPage();
    const draws = captureTextDraws(doc);
    await renderApBillInto(doc, autoTable, bill({ status: 'DRAFT', je_no: null, posted_at: null }), nameOf);
    const has = (needle: string) => draws.some((d) => d.text.includes(needle));
    expect(has('AP BILL')).toBe(true);
    expect(has('No: 2990-API-2609-001')).toBe(true);
    expect(has('DRAFT · not posted to the ledger')).toBe(true);
    expect(has('HOUZS VENTURE HOLDING SDN BHD')).toBe(true);
    expect(has('Supplier’s invoice no.')).toBe(true);
    expect(has('Rent Sept')).toBe(true);
    expect(has('TOTAL')).toBe(true);
    expect(has('RINGGIT MALAYSIA FOUR THOUSAND TWO HUNDRED ONLY')).toBe(true);
    expect(has('Created by Nico')).toBe(true);
    expect(has('Page 1 of 1')).toBe(true);
    expect(doc.getNumberOfPages()).toBe(2);
  });
});
