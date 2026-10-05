/* The Consignment Order is the paper a customer signs for a TEMPORARY
 * PROVISION — goods lent while their own order is corrected. It replaced the
 * "Temporary provision" letter (HC-SL0047) on 2026-10-05. The CO prints
 * through the Sales Order template, which used to carry the POS receipt terms
 * (tax invoice, balance due, surcharges) with only the noun swapped — wording
 * that is simply false for a loan.
 *
 * Asserted on what the generator DREW (`doc.text`), the technique
 * sales-order-pdf-category-heading.test.ts uses, so a caller that drops the
 * shared opts and goes back to the receipt terms fails here. */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';

type JsPdf = import('jspdf').jsPDF;

function captureText(doc: JsPdf): string[] {
  const drawn: string[] = [];
  const original = doc.text.bind(doc);
  vi.spyOn(doc, 'text').mockImplementation(((...args: Parameters<typeof doc.text>) => {
    const [value] = args;
    for (const line of Array.isArray(value) ? value.map(String) : [String(value)]) drawn.push(line.trim());
    return original(...args);
  }) as typeof doc.text);
  return drawn;
}

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
  vi.restoreAllMocks();
});

const HEADER = {
  doc_no: 'HC-CS-2610-001', so_date: '2026-10-05', status: 'CONFIRMED',
  debtor_code: 'C-1', debtor_name: 'Test Customer', agent: null,
  branding: null, venue: null, ref: null as string | null, po_doc_no: null, phone: null,
  address1: '1 Jalan Test', address2: null, address3: null, address4: null,
  mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, others_sen: 0,
  local_total_sen: 0, line_count: 1, currency: 'MYR', note: null, paid_sen_total: 0,
};
const ITEMS = [{
  id: 'i-1', item_group: 'bedframe', item_code: 'DIVAN ONLY-(K)', description: 'DIVAN ONLY BEDFRAME', uom: 'UNIT',
  qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0, variants: null,
}];

async function printedText(
  opts: Parameters<typeof import('./sales-order-pdf').renderSalesOrderInto>[6],
  header: Partial<typeof HEADER> & { ref?: string | null } = {},
): Promise<string> {
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderSalesOrderInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./sales-order-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const drawn = captureText(doc);
  await renderSalesOrderInto(doc, autoTable, { ...HEADER, ...header }, ITEMS, [], [], opts);
  /* Terms wrap through splitTextToSize, so a phrase can straddle two drawn lines. */
  return drawn.join(' ').replace(/\s+/g, ' ');
}

describe('consignment order PDF — temporary-provision terms', () => {
  test('the CO prints the loan terms, not the receipt terms', async () => {
    const { CONSIGNMENT_ORDER_PDF_OPTS } = await import('./sales-order-pdf');
    const text = await printedText(CONSIGNMENT_ORDER_PDF_OPTS);
    expect(text).toContain('temporary provision');
    expect(text).toContain('misuse, negligence or intentional acts');
    expect(text).toContain('By signing below');
    expect(text).not.toContain('binding tax invoice');
    expect(text).not.toContain('rescheduling surcharge');
  });

  test('the CO prints no payments ledger, totals or amount in words', async () => {
    const { CONSIGNMENT_ORDER_PDF_OPTS } = await import('./sales-order-pdf');
    const text = await printedText(CONSIGNMENT_ORDER_PDF_OPTS);
    expect(text).not.toContain('PAYMENTS RECEIVED');
    expect(text).not.toContain('BALANCE DUE');
    expect(text).not.toContain('Amount in words');
    expect(text).toContain('Customer Signature');
  });

  test('the CO prints the Ref No. row even when blank, and the contact line', async () => {
    const { CONSIGNMENT_ORDER_PDF_OPTS } = await import('./sales-order-pdf');
    const blank = await printedText(CONSIGNMENT_ORDER_PDF_OPTS);
    expect(blank).toContain('Ref No.');
    const filled = await printedText(CONSIGNMENT_ORDER_PDF_OPTS, { ref: 'HC-SO-009191' });
    expect(filled).toContain('Ref No.');
    expect(filled).toContain('HC-SO-009191');
    expect(filled).toContain('contact us at');
  });

  test('the sales order keeps the receipt terms', async () => {
    const text = await printedText(undefined);
    expect(text).toContain('binding tax invoice');
    expect(text).not.toContain('temporary provision');
    expect(text).toContain('PAYMENTS RECEIVED');
    expect(text).toContain('BALANCE DUE');
  });

  test('both CO print paths read the one shared opts object', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const pages = resolve(__dirname, '../../../pages/scm-v2');
    for (const f of ['ConsignmentOrderDetail.tsx', 'ConsignmentOrders.tsx']) {
      const src = readFileSync(resolve(pages, f), 'utf8');
      expect(src, f).toContain('CONSIGNMENT_ORDER_PDF_OPTS');
      expect(src, f).not.toContain("docNoun: 'consignment order'");
    }
  });
});
