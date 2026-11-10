// Sister-ERP gap review G11: a combined PO print numbers each PO's own pages,
// in the header ("<PO no> · Page x of y") and the footer, instead of counting
// the whole file.
import { describe, expect, it, vi } from 'vitest';
import { pdfRawText } from './pdf-raw-text';

vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));
vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));
const delivered = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));
vi.mock('./pdf-common', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  deliverPdf: (doc: { output: (t: 'arraybuffer') => ArrayBuffer }) => {
    delivered.bytes = new Uint8Array(doc.output('arraybuffer'));
  },
}));

type PoArgs = Parameters<typeof import('./purchase-order-pdf').purchaseOrderPdfBase64>;

const header = (po: string, revision: number): PoArgs[0] => ({
  id: po, po_number: po, revision, supplier_id: null, status: 'SUBMITTED', po_date: '2026-10-29',
  expected_at: '2026-12-15', currency: 'MYR', subtotal_sen: 120000, tax_sen: 0, total_sen: 120000, notes: null,
  purchase_location_name: 'KL WAREHOUSE', supplier: { code: '400-T001', name: 'T.H.L. SOFA SDN BHD' },
} as PoArgs[0]);

const line = (n: number): PoArgs[1][number] => ({
  id: `l-${n}`, item_code: `ITEM-${n}`, material_name: `ITEM ${n}`, supplier_sku: null, qty: 1,
  unit_price_sen: 120000, line_total_sen: 120000, uom: 'UNIT', item_group: 'others', variants: {}, delivery_date: '2026-12-15',
});

describe('combined PO PDF page numbers', () => {
  it('restarts at Page 1 for the second PO, header and footer', async () => {
    const { generateCombinedPurchaseOrderPdf } = await import('./purchase-order-pdf');
    await generateCombinedPurchaseOrderPdf([
      { header: header('PO-A', 1), items: Array.from({ length: 40 }, (_, i) => line(i)) },
      { header: header('PO-B', 2), items: [line(99)] },
    ]);
    const raw = pdfRawText(delivered.bytes!);
    const heads = [...raw.matchAll(/\((PO-[AB](?:_R\d)? · Page \d+ of \d+)\)/g)].map((m) => m[1]!);
    const aPages = heads.filter((h) => h.startsWith('PO-A ')).length;
    expect(aPages).toBeGreaterThan(1);
    expect(heads).toEqual([
      ...Array.from({ length: aPages }, (_, i) => `PO-A · Page ${i + 1} of ${aPages}`),
      'PO-B_R1 · Page 1 of 1',
    ]);
    const feet = [...raw.matchAll(/\((Page \d+ of \d+)    ·    Generated/g)].map((m) => m[1]!);
    expect(feet.at(-1)).toBe('Page 1 of 1');
  });
});
