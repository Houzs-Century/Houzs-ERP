/* The Credit / Debit Note print (docs/bugs/0834) — what it DRAWS, captured off
   `doc.text` the way payment-voucher-pdf.test.ts does. Pinned: the title is
   the kind's; the party; the papers it answers — the sales order, the deposit
   invoice it closes, the final invoice, a free reference, the reason; each
   line's description, account and amount; TOTAL in figures and words; a
   draft's and a cancelled note's watermark. */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import type { CreditNoteKnockedOff, CreditNotePdfHeader, CreditNotePdfLine } from './credit-note-pdf';
import type { CreditNote } from './credit-note-queries';

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

describe("an other debtor's credit note", () => {
  test("CUSTOMER carries the debtor's account code, read off the registry (party_code stays blank, owner 2026-11-03)", async () => {
    const draws = await render({ kind: 'OCN', party_name: 'EASTERN DECORATOR', party_code: null, debtor_code: '305-E003' });
    expect(has(draws, '305-E003')).toBe(true);
    const bare = await render({ kind: 'OCN', party_name: 'EASTERN DECORATOR', party_code: null, debtor_code: null });
    expect(bare.some((d) => d.text === 'Code')).toBe(false);
  });
});

describe('the credit note sheet', () => {
  /* The design's A4 family (batch 5 step 10): CUSTOMER beside NOTE DETAILS, the
     lines without our accounts, TOTAL CREDIT, the words, Issued by. */
  test('a customer credit note names the customer, the order, the deposit invoice it closes and the final invoice', async () => {
    const draws = await render();
    expect(has(draws, 'CREDIT NOTE')).toBe(true);
    expect(has(draws, 'SUPPLIER CREDIT NOTE')).toBe(false);
    expect(has(draws, '2990-CN-2609-001')).toBe(true);
    expect(has(draws, 'CUSTOMER')).toBe(true);
    expect(has(draws, 'NOTE DETAILS')).toBe(true);
    expect(has(draws, 'Larding Chen')).toBe(true);
    expect(has(draws, ': 2990-SO-2609-001')).toBe(true);
    expect(has(draws, ': 2990-DI-2609-001')).toBe(true);
    expect(has(draws, ': 2990-SI-2609-001')).toBe(true);
    expect(has(draws, ': Posted')).toBe(true);
    expect(has(draws, 'Deposit invoice 2990-DI-2609-001 applied to 2990-SI-2609-001')).toBe(true);
    /* Our accounts stay off the customer's paper. */
    expect(has(draws, '509-0000')).toBe(false);
    expect(has(draws, 'TOTAL CREDIT')).toBe(true);
    expect(has(draws, 'RINGGIT (IN WORDS)')).toBe(true);
    expect(has(draws, 'ONE THOUSAND')).toBe(true);
    expect(has(draws, 'Issued by')).toBe(true);
    expect(has(draws, 'DRAFT')).toBe(false);
  });

  test('a blank line reads as the name of its account; a debit note totals as TOTAL DEBIT', async () => {
    const dn = await render({ kind: 'DN', status: 'POSTED', source_doc_no: 'DR-2609-002', sales_invoice_number: null, reason: 'Late delivery fee' },
      [{ description: null, account_code: '510-0000', amount_sen: 2_050 }]);
    expect(has(dn, 'DEBIT NOTE')).toBe(true);
    expect(has(dn, 'RETURN INWARDS')).toBe(true);
    expect(has(dn, '510-0000')).toBe(false);
    expect(has(dn, 'TOTAL DEBIT')).toBe(true);
    expect(has(dn, ': DR-2609-002')).toBe(true);
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

/* What a credit note knocked off (the design's KNOCKED OFF AGAINST; owner 2026-11-03: 「要」). */
describe('KNOCKED OFF AGAINST', () => {
  const HAND = { source_doc_no: 'DR-2611-001', sales_invoice_number: null, reason: 'Scratched headboard', total_sen: 50_000, note_number: 'HC-CN-2611-001' };
  const GOODWILL: CreditNotePdfLine[] = [{ description: 'Goodwill', account_code: '510-0000', amount_sen: 50_000 }];
  async function renderKo(over: Partial<CreditNotePdfHeader>, lines: CreditNotePdfLine[], knockedOff: CreditNoteKnockedOff | null): Promise<TextDraw[]> {
    setUpBranding();
    const [{ jsPDF }, { default: autoTable }, { renderCreditNoteInto }] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('./credit-note-pdf')]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const draws = captureTextDraws(doc);
    renderCreditNoteInto(doc, autoTable, { ...HEADER, ...over }, lines, nameOf, knockedOff);
    return draws;
  }

  test('each invoice it knocked off, then what stays as credit on the account', async () => {
    const draws = await renderKo(HAND, GOODWILL, { rows: [{ number: 'HC-SI-2611-001', date: '2026-11-01', totalSen: 300_000, knockedSen: 30_000 }], leftSen: 20_000 });
    expect(has(draws, 'KNOCKED OFF AGAINST')).toBe(true);
    expect(has(draws, 'Invoice No')).toBe(true);
    expect(has(draws, 'HC-SI-2611-001')).toBe(true);
    expect(has(draws, '3,000.00')).toBe(true);
    expect(has(draws, '300.00')).toBe(true);
    expect(has(draws, 'Not applied · credit on account')).toBe(true);
  });

  test('nothing knocked off says so; a debit note and a note without the block print none', async () => {
    expect(has(await renderKo(HAND, GOODWILL, { rows: [], leftSen: 50_000 }), 'Not knocked off · credit on account')).toBe(true);
    expect(has(await renderKo({ ...HAND, kind: 'DN' }, GOODWILL, { rows: [], leftSen: 50_000 }), 'KNOCKED OFF AGAINST')).toBe(false);
    expect(has(await renderKo(HAND, GOODWILL, null), 'KNOCKED OFF AGAINST')).toBe(false);
  });

  test('knockedOffOf: a posted note takes what was applied, a draft its plan, a close-out its final invoice; a refund and a cancelled note none', async () => {
    const { knockedOffOf } = await import('./credit-note-pdf');
    const n = { kind: 'CN', status: 'POSTED', total_sen: 50_000 } as unknown as CreditNote;
    const al = (amountSen: number, appliedSen: number) => ({ id: 'a', kind: 'SI' as const, docId: 'si-1', number: 'HC-SI-2611-001', docDate: '2026-11-01', docTotalSen: 300_000, amountSen, appliedSen, createdAt: null, createdBy: null });
    expect(knockedOffOf({ note: n, allocations: [al(30_000, 30_000)] })).toEqual({ rows: [{ number: 'HC-SI-2611-001', date: '2026-11-01', totalSen: 300_000, knockedSen: 30_000 }], leftSen: 20_000 });
    expect(knockedOffOf({ note: { ...n, status: 'DRAFT' }, allocations: [al(10_000, 0)] })?.rows[0]?.knockedSen).toBe(10_000);
    expect(knockedOffOf({ note: n, allocations: [], depositPaper: { kind: 'closes', di: 'HC-DI-2611-001' }, closedInvoice: { id: 'si-7', number: 'HC-SI-2611-007', date: '2026-11-01', totalSen: 400_000 } }))
      .toEqual({ rows: [{ number: 'HC-SI-2611-007', date: '2026-11-01', totalSen: 400_000, knockedSen: 50_000 }], leftSen: 0 });
    expect(knockedOffOf({ note: n, allocations: [], depositPaper: { kind: 'refund', di: 'HC-DI-2611-001' } })).toBeNull();
    expect(knockedOffOf({ note: { ...n, status: 'CANCELLED' }, allocations: [al(30_000, 30_000)] })).toBeNull();
    expect(knockedOffOf({ note: { ...n, kind: 'SCN' }, allocations: [] })).toBeNull();
  });
});
