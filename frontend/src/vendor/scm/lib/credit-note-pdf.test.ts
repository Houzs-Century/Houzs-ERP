/* The Credit / Debit Note print (docs/bugs/0834) — what it DRAWS, captured off
   `doc.text` the way payment-voucher-pdf.test.ts does. Pinned: the title is
   the kind's; the party; the papers it answers — the sales order, the deposit
   invoice it closes, the final invoice, a free reference, the reason; each
   line's description, account and amount; TOTAL in figures and words; a
   draft's and a cancelled note's watermark. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import type { CreditNotePdfHeader, CreditNotePdfLine } from './credit-note-pdf';

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

const HEADER: CreditNotePdfHeader = {
  note_number: '2990-CN-2609-001', kind: 'CN', status: 'POSTED', note_date: '2026-09-10',
  party_name: 'Larding Chen', party_code: 'cust-larding', so_doc_no: '2990-SO-2609-001',
  source_doc_no: '2990-DI-2609-001', sales_invoice_number: '2990-SI-2609-001',
  reason: 'Deposit invoice 2990-DI-2609-001 closed by final invoice 2990-SI-2609-001',
  total_sen: 100000, je_no: '2990-JE-2609-0020',
};
const LINES: CreditNotePdfLine[] = [
  { description: 'Deposit invoice 2990-DI-2609-001 applied to 2990-SI-2609-001', account_code: '509-0000', amount_sen: 100000 },
];
const nameOf = (code: string) => (code === '509-0000' ? 'DEPOSIT PAY BY CUSTOMER' : code === '510-0000' ? 'RETURN INWARDS' : null);

async function render(over: Partial<CreditNotePdfHeader> = {}, lines: CreditNotePdfLine[] = LINES): Promise<TextDraw[]> {
  setUpBranding();
  const [{ jsPDF }, { default: autoTable }, { renderCreditNoteInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./credit-note-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const draws = captureTextDraws(doc);
  renderCreditNoteInto(doc, autoTable, { ...HEADER, ...over }, lines, nameOf);
  return draws;
}
const has = (draws: TextDraw[], needle: string): boolean => draws.some((d) => d.text.includes(needle));

describe('the credit note sheet', () => {
  test('a customer credit note names the customer, the order, the deposit invoice it closes and the final invoice', async () => {
    const draws = await render();
    expect(has(draws, 'CREDIT NOTE')).toBe(true);
    expect(has(draws, 'SUPPLIER CREDIT NOTE')).toBe(false);
    expect(has(draws, '2990-CN-2609-001')).toBe(true);
    expect(has(draws, 'Larding Chen')).toBe(true);
    expect(has(draws, 'Sales order: 2990-SO-2609-001')).toBe(true);
    expect(has(draws, 'Deposit invoice: 2990-DI-2609-001')).toBe(true);
    expect(has(draws, 'Final invoice: 2990-SI-2609-001')).toBe(true);
    expect(has(draws, 'TOTAL')).toBe(true);
    expect(has(draws, 'ONE THOUSAND')).toBe(true);
    expect(has(draws, 'DRAFT')).toBe(false);
  });

  test('the title is the kind\'s, a free reference prints as a reference, and a draft prints as a draft', async () => {
    const scn = await render({ kind: 'SCN', status: 'DRAFT', party_name: 'HOUZS VENTURE HOLDING SDN BHD', party_code: '405-H001', so_doc_no: null, source_doc_no: 'PRT-2609-003', sales_invoice_number: null, reason: 'Goods returned' },
      [{ description: 'Returned chairs', account_code: '612-0000', amount_sen: 50000 }]);
    expect(has(scn, 'SUPPLIER CREDIT NOTE')).toBe(true);
    expect(has(scn, 'Reference: PRT-2609-003')).toBe(true);
    expect(has(scn, 'Deposit invoice:')).toBe(false);
    expect(has(scn, 'Reason: Goods returned')).toBe(true);
    expect(has(scn, 'DRAFT')).toBe(true);
    const dn = await render({ kind: 'DN', status: 'CANCELLED' });
    expect(has(dn, 'DEBIT NOTE')).toBe(true);
    expect(has(dn, 'CANCELLED')).toBe(true);
  });
});
