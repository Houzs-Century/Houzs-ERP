/* A printed Sales Order names each section by the category's NAME, not its code.
 *
 * HC-SO-2609-071 (owner 2026-09-15, 「为什么是 show fabric accessory 呢？不是 sofa
 * accessory？」): five pillow / cushion lines in `fabric_accessory` printed under
 * the heading FABRIC_ACCESSORY, the raw stored group, while every screen calls
 * the category Sofa Accessory (vendor/shared/product-categories.ts).
 *
 * The assertion is on what the generator DREW (`doc.text`, which
 * jspdf-autotable paints through), the technique pdf-status-label.test.ts uses,
 * so a generator that goes back to printing the code fails here whatever helper
 * it imports. */
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

async function printedText(groups: string[]): Promise<string[]> {
  /* Plain ASCII, no variants, no logo: no font fetch and no network. */
  setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
  const [{ jsPDF }, { default: autoTable }, { renderSalesOrderInto }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('./sales-order-pdf'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const drawn = captureText(doc);
  await renderSalesOrderInto(doc, autoTable, {
    doc_no: 'HC-SO-2609-071', so_date: '2026-09-14', status: 'IN_PRODUCTION',
    debtor_code: 'C-1', debtor_name: 'Test Sdn Bhd', agent: null,
    branding: null, venue: null, ref: null, po_doc_no: null, phone: null,
    address1: '1 Jalan Test', address2: null, address3: null, address4: null,
    mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, others_sen: 0,
    local_total_sen: 0, line_count: groups.length, currency: 'MYR', note: null, paid_sen_total: 0,
  }, groups.map((g, i) => ({
    id: `i-${i}`, item_group: g, item_code: `CODE-${i}`, description: `Line ${i}`, uom: 'UNIT',
    qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0, variants: null,
  })));
  return drawn;
}

describe('sales order PDF — category section headings', () => {
  test('a Sofa Accessory section is headed SOFA ACCESSORY, never FABRIC_ACCESSORY', async () => {
    const drawn = await printedText(['sofa', 'fabric_accessory', 'fabric_accessory']);
    expect(drawn).toContain('SOFA ACCESSORY');
    expect(drawn.filter((t) => t.includes('FABRIC_ACCESSORY'))).toEqual([]);
  });

  test('the existing headings still read as before', async () => {
    const drawn = await printedText(['sofa', 'bedframe', 'mattress', 'service']);
    for (const heading of ['SOFA', 'BEDFRAME', 'MATTRESS', 'SERVICE']) expect(drawn).toContain(heading);
  });

  test('a group that is not a category still prints as stored', async () => {
    expect(await printedText(['others'])).toContain('OTHERS');
  });
});
