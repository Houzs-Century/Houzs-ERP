/* The printed Sales Order and the supplier's Purchase Order show a Sofa Accessory
 * line's colour once when its Special Order note only repeats it.
 *
 * Production lines (read-only run 34965615433): HC-SO-013503 LONG PILLOW
 * { fabricCode COVE-13, extraAddonNote "Col : cove 13" } printed
 * "COVE-13 / SPECIAL: Col : cove 13"; HC-PO-2609-103 SB02 { COVE-08, "COVE-08" }
 * printed "Fabric: COVE-08 / SPECIAL: COVE-08". Asserted on what the real
 * generators PAINT into the PDF stream (docs/bugs/0934). */
import { afterEach, describe, expect, test } from 'vitest';

import { DEFAULT_BRANDING, clearBrandingLogoCache, setBrandingCache } from '../../../lib/branding';
import { purchaseOrderPdfBase64 } from './purchase-order-pdf';

type PoHeader = Parameters<typeof purchaseOrderPdfBase64>[0];
type PoItem = Parameters<typeof purchaseOrderPdfBase64>[1][number];

/* Every string the PDF stream paints, joined: a table cell wraps long text into
   several text operations, so one phrase can span two of them. */
const painted = (raw: string) =>
  [...raw.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');

const PO_HEADER: PoHeader = {
  po_number: 'HC-PO-2609-103', supplier_id: null, status: 'SUBMITTED', po_date: '2026-09-15', expected_at: null,
  currency: 'MYR', subtotal_sen: 0, tax_sen: 0, total_sen: 0, notes: null, your_ref_no: null,
  purchase_location_name: 'KL', supplier: { code: 'S-1', name: 'TEST SUPPLIER', address: '1 JALAN TEST' },
};

const poLine = (itemCode: string, variants: Record<string, unknown>, description2: string | null): PoItem => ({
  item_code: itemCode, material_name: itemCode, description2, notes: null, supplier_sku: itemCode,
  qty: 1, unit_price_sen: 0, line_total_sen: 0, uom: 'UNIT', item_group: 'fabric_accessory', so_doc_no: null, variants,
});

const poText = async (line: PoItem) =>
  painted(Buffer.from(await purchaseOrderPdfBase64(PO_HEADER, [line]), 'base64').toString('latin1'));

afterEach(() => {
  setBrandingCache({ ...DEFAULT_BRANDING }, 'HOUZS');
  clearBrandingLogoCache();
});

describe('a note that only restates the colour prints once', () => {
  test('Sales Order PDF — HC-SO-013503 LONG PILLOW', async () => {
    setBrandingCache({ ...DEFAULT_BRANDING, logoR2Key: '' }, 'HOUZS');
    const [{ jsPDF }, { default: autoTable }, { renderSalesOrderInto }] = await Promise.all([
      import('jspdf'), import('jspdf-autotable'), import('./sales-order-pdf'),
    ]);
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    await renderSalesOrderInto(doc, autoTable, {
      doc_no: 'HC-SO-013503', so_date: '2026-09-14', status: 'CONFIRMED', debtor_code: 'C-1', debtor_name: 'Test',
      agent: null, branding: null, venue: null, ref: null, po_doc_no: null, phone: null,
      address1: '1 Jalan Test', address2: null, address3: null, address4: null,
      mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, others_sen: 0,
      local_total_sen: 0, line_count: 1, currency: 'MYR', note: null, paid_sen_total: 0,
    }, [{
      id: 'l-1', item_group: 'fabric_accessory', item_code: 'LONG PILLOW', description: 'AMN-LONG PILLOW (12"X28")',
      description2: 'Col : cove 13', uom: 'UNIT', qty: 1, unit_price_sen: 0, discount_sen: 0, total_sen: 0,
      variants: { fabricCode: 'COVE-13', extraAddonNote: 'Col : cove 13' },
    }]);
    const text = painted(doc.output());
    expect(text).toContain('COVE-13');
    expect(text).not.toContain('SPECIAL');
  });

  test('supplier Purchase Order PDF — HC-PO-2609-103 SB02', async () => {
    const text = await poText(poLine('SB02', { fabricCode: 'COVE-08', extraAddonNote: 'COVE-08' }, 'COVE-08 / SPECIAL: COVE-08'));
    expect(text).toContain('Fabric: COVE-08');
    expect(text).not.toContain('SPECIAL');
  });

  test('a note that says more still prints on the supplier copy', async () => {
    const text = await poText(poLine('SQUARE PILLOW', { fabricCode: 'BO315-28', extraAddonNote: 'BO315-28 SKY x2' }, null));
    expect(text).toMatch(/SPECIAL: BO315-28\s+SKY x2/);
  });
});
