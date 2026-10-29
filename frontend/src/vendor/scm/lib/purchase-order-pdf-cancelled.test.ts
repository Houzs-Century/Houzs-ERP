// 2990-0028 (Sim 2026-10-29): a cancelled PO prints CANCELLED across every page.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));
import { writeFileSync } from 'node:fs';

vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));

type PoArgs = Parameters<typeof import('./purchase-order-pdf').purchaseOrderPdfBase64>;

const header = (status: string): PoArgs[0] => ({
  id: 'po-1',
  po_number: '2990-PO-2610-072',
  supplier_id: null,
  status,
  po_date: '2026-10-29',
  expected_at: '2026-12-15',
  currency: 'MYR',
  subtotal_sen: 120000,
  tax_sen: 0,
  total_sen: 120000,
  notes: null,
  purchase_location_name: 'KL WAREHOUSE',
  supplier: { code: '400-T001', name: 'T.H.L. SOFA SDN BHD' },
});

const line = (n: number): PoArgs[1][number] => ({
  id: `po-line-${n}`,
  item_code: `THL2376-1A(R)(LHF)-${n}`,
  material_name: 'THL2376 1A(R) LHF',
  supplier_sku: null,
  qty: 1,
  unit_price_sen: 120000,
  line_total_sen: 120000,
  uom: 'UNIT',
  item_group: 'others',
  variants: {},
  delivery_date: '2026-12-15',
});

const render = async (status: string, lines: number) => {
  const { purchaseOrderPdfBase64 } = await import('./purchase-order-pdf');
  const items = Array.from({ length: lines }, (_, i) => line(i + 1));
  const pdf = Buffer.from(await purchaseOrderPdfBase64(header(status), items), 'base64');
  const raw = pdf.toString('latin1');
  return {
    pdf,
    stamps: raw.split('(CANCELLED)').length - 1,
    pages: (raw.match(/\/Type \/Page\b(?!s)/g) ?? []).length,
  };
};

describe('purchase-order-pdf CANCELLED watermark', () => {
  it('stamps a cancelled PO once per page, over a multi-page order', async () => {
    const { pdf, stamps, pages } = await render('CANCELLED', 40);
    if (process.env.CANCELLED_PDF_OUT) writeFileSync(process.env.CANCELLED_PDF_OUT, pdf);
    expect(pages).toBeGreaterThan(1);
    expect(stamps).toBe(pages);
  });

  it('prints no stamp on a live PO', async () => {
    for (const status of ['SUBMITTED', 'PARTIAL_RECEIVED', 'RECEIVED', 'DRAFT']) {
      expect((await render(status, 1)).stamps).toBe(0);
    }
  });
});
