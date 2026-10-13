// DEV-74 (Sim 2026-10-13): a bedframe line with a drawer special prints a
// pull-out picture for the supplier; a line without one prints as before.
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../hooks/useBranding', () => ({ ensureBrandingForActiveCompany: async () => {} }));
import { writeFileSync } from 'node:fs';
import { drawerSidesOf } from './po-drawer-diagram';

vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));

type PoArgs = Parameters<typeof import('./purchase-order-pdf').purchaseOrderPdfBase64>;

const header: PoArgs[0] = {
  id: 'po-1',
  po_number: 'HC-PO-2610-200',
  supplier_id: null,
  status: 'SUBMITTED',
  po_date: '2026-10-13',
  expected_at: null,
  currency: 'MYR',
  subtotal_sen: 55000,
  tax_sen: 0,
  total_sen: 55000,
  notes: null,
  your_ref_no: null,
  purchase_location_name: null,
  supplier: null,
};

const line = (variants: Record<string, unknown>): PoArgs[1][number] => ({
  id: 'po-line-1',
  item_code: 'NB-NBG06(Q)',
  material_name: 'CROWN-(Q)',
  supplier_sku: null,
  qty: 1,
  unit_price_sen: 55000,
  line_total_sen: 55000,
  uom: 'UNIT',
  item_group: 'bedframe',
  variants,
});

const render = async (variants: Record<string, unknown>) => {
  const { purchaseOrderPdfBase64 } = await import('./purchase-order-pdf');
  const pdf = Buffer.from(await purchaseOrderPdfBase64(header, [line(variants)]), 'base64');
  return { pdf, raw: pdf.toString('latin1') };
};

describe('drawerSidesOf', () => {
  it.each([
    [{ specials: ['Left Drawer'] }, ['LEFT']],
    [{ specials: ['Front Drawer', 'HB Straight', 'right drawer'] }, ['RIGHT', 'FRONT']],
    [{ special: 'Right Drawer' }, ['RIGHT']],
    [{ specials: ['HB Fully Cover'] }, []],
    [{}, []],
  ] as const)('%j -> %j', (v, want) => {
    expect(drawerSidesOf(v as Record<string, unknown>)).toEqual(want);
  });
});

describe('purchase-order-pdf drawer picture', () => {
  it('a LEFT drawer line prints the pull-out-left picture', async () => {
    const { pdf, raw } = await render({ specials: ['Left Drawer'] });
    expect(raw).toContain('(PULL OUT LEFT)');
    if (process.env.DRAWER_PDF_OUT) writeFileSync(process.env.DRAWER_PDF_OUT, pdf);
  });

  it('a line without a drawer prints no picture', async () => {
    const { raw } = await render({ specials: ['HB Fully Cover'] });
    expect(raw).not.toContain('PULL OUT');
  });
});
