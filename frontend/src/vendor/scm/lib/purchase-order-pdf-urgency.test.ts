// DEV-65 (Sim 2026-10-09): the PO prints "URGENT" when the delivery date is
// under 2 weeks after the PO date and "TOP URGENT" under 1 week.
import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { poUrgencyLabel } from './purchase-order-pdf';

vi.mock('./sales-order-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSofaCompartmentArtForPrint: async () => new Map(),
}));

type PoArgs = Parameters<typeof import('./purchase-order-pdf').purchaseOrderPdfBase64>;

const header = (expected_at: string | null, extra: Partial<PoArgs[0]> = {}): PoArgs[0] => ({
  id: 'po-1',
  po_number: 'HC-PO-2610-178',
  supplier_id: null,
  status: 'SUBMITTED',
  po_date: '2026-10-09',
  expected_at,
  currency: 'MYR',
  subtotal_sen: 55000,
  tax_sen: 0,
  total_sen: 55000,
  notes: null,
  your_ref_no: 'HC-SO-2609-098',
  purchase_location_name: 'KL WAREHOUSE',
  supplier: {
    code: '400-H004',
    name: 'HOOKKA INDUSTRIES SDN. BHD.',
    address: '2775F JALAN INDUSTRI 12, KAMPUNG BARU SUNGAI BULOH, 47000 SUNGAI BULOH., SUNGAI BULOH, 47000 Selangor, Malaysia',
    phone: '+601161333173',
    email: 'support@hookka.com',
    contact_person: 'MS VIOLET',
    payment_terms: '30 DAYS',
  },
  ...extra,
});

const line: PoArgs[1][number] = {
  id: 'po-line-1',
  item_code: 'FENRIR-BF-6FT',
  material_name: 'FENRIR BEDFRAME (6FT) (183X190CM)',
  supplier_sku: 'HOK-1005-(K)',
  qty: 1,
  unit_price_sen: 55000,
  line_total_sen: 55000,
  uom: 'UNIT',
  item_group: 'bedframe',
  so_doc_no: 'HC-SO-2609-098',
  variants: {},
  delivery_date: '2026-10-18',
};

const render = async (h: PoArgs[0]) => {
  const { purchaseOrderPdfBase64 } = await import('./purchase-order-pdf');
  const pdf = Buffer.from(await purchaseOrderPdfBase64(h, [line]), 'base64');
  return { pdf, raw: pdf.toString('latin1') };
};

describe('poUrgencyLabel', () => {
  it.each([
    ['2026-10-09', '2026-10-09', 'TOP URGENT'],
    ['2026-10-09', '2026-10-15', 'TOP URGENT'],
    ['2026-10-09', '2026-10-16', 'URGENT'],
    ['2026-10-09', '2026-10-18', 'URGENT'],
    ['2026-10-09', '2026-10-22', 'URGENT'],
    ['2026-10-09', '2026-10-23', null],
    ['2026-10-09', '2026-11-30', null],
    ['2026-10-09', null, null],
    [null, '2026-10-18', null],
  ] as const)('PO %s, delivery %s -> %s', (po, del, want) => {
    expect(poUrgencyLabel(po, del)).toBe(want);
  });

  it('reads a timestamp PO date as its Malaysia calendar day', () => {
    // 2026-10-08T17:00Z is 2026-10-09 01:00 MYT, printed as 2026/10/09.
    expect(poUrgencyLabel('2026-10-08T17:00:00Z', '2026-10-23')).toBeNull();
  });
});

describe('purchase-order-pdf urgency badge', () => {
  it('prints URGENT for the ticket PO (9 days)', async () => {
    const { pdf, raw } = await render(header('2026-10-18'));
    expect(raw).toContain('(URGENT)');
    if (process.env.URGENCY_PDF_OUT) writeFileSync(process.env.URGENCY_PDF_OUT, pdf);
  });

  it('prints TOP URGENT under a week', async () => {
    const { raw } = await render(header('2026-10-14'));
    expect(raw).toContain('(TOP URGENT)');
  });

  it('uses the supplier-revised delivery date', async () => {
    const { raw } = await render(header('2026-10-14', { supplier_delivery_date_2: '2026-11-30' }));
    expect(raw).not.toContain('URGENT)');
  });

  it('prints nothing at 2 weeks or more, or with no delivery date', async () => {
    expect((await render(header('2026-10-23'))).raw).not.toContain('URGENT)');
    expect((await render(header(null))).raw).not.toContain('URGENT)');
  });
});
