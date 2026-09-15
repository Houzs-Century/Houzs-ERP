// GET /purchase-invoices/export/rows — every Purchase Invoice the list's filter
// matches, each carrying its lines, for the grid-driven export (owner
// 2026-09-15). Harness as purchase-invoice-exports.test.ts.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';
import { fakeSb } from '../lib/fake-postgrest';
import { piExportRowsHandler } from './purchase-invoice-exports';

type Row = Record<string, unknown>;
let seq = 0;
const pi = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pi-${String(seq).padStart(5, '0')}`, company_id: 1, invoice_number: `HC-PI-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null, invoice_date: '2026-09-01', status: 'POSTED', on_hold: false, notes: null, supplier_invoice_ref: null,
    currency: 'MYR', due_date: null, total_sen: 100000, paid_sen: 0, supplier_id: 'sup-1', supplier: { code: '400-D001', name: 'DIGLANT' }, ...over,
  };
};
const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pii-${String(seq).padStart(5, '0')}`, purchase_invoice_id: h.id, company_id: h.company_id, created_at: '2026-09-01T00:00:00Z',
    grn_item_id: null, item_code: 'CODY-(K)', material_name: 'CODY KING', description: null, description2: null, notes: null,
    item_group: 'mattress', uom: 'UNIT', qty: 2, po_unit_price_sen: 50000, unit_price_sen: 50000, discount_sen: 0, line_total_sen: 100000, variants: null, ...over,
  };
};

type Tables = { pis: Row[]; lines: Row[]; grnLines?: Row[]; grns?: Row[]; poLines?: Row[]; pos?: Row[]; so?: Row[] };
function app(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    purchase_invoices: t.pis, purchase_invoice_items: t.lines, grn_items: t.grnLines ?? [], grns: t.grns ?? [],
    purchase_order_items: t.poLines ?? [], purchase_orders: t.pos ?? [], mfg_sales_order_items: t.so ?? [],
    supplier_material_bindings: [], warehouses: [{ id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG' }],
  }, {}, [], [], maxRows);
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    await next();
  });
  a.get('/export/rows', piExportRowsHandler);
  return a;
}
type Body = { purchaseInvoices: Array<Row & { lines: Row[] }>; total: number; lineCount: number; truncated: boolean };

describe('GET /purchase-invoices/export/rows', () => {
  it('holds every invoice of the tab past the ceiling, each carrying its lines', async () => {
    const pis: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_004; i += 1) {
      const h = pi();
      pis.push(h);
      lines.push(line(h));
    }
    const paid = pi({ status: 'PAID' });
    const res = await app({ pis: [...pis, paid], lines: [...lines, line(paid)] }, 1, 1_000).request('/export/rows?status=posted');
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_004);
    expect(body.lineCount).toBe(1_004);
    expect(body.purchaseInvoices.map((r) => r.id)).not.toContain(paid.id);
    expect(body.truncated).toBe(false);
  });

  it('reaches SKU, GRN, location and the AutoCount PO number through the GRN line, company-scoped', async () => {
    const h = pi();
    const mine = line(h, { grn_item_id: 'gi-1' });
    const theirs = line(h, { grn_item_id: 'gi-x' });
    const planted = line(h, { company_id: 2 });
    const res = await app({
      pis: [h],
      lines: [mine, theirs, planted],
      grnLines: [
        { id: 'gi-1', company_id: 1, grn_id: 'grn-1', supplier_sku: 'DG-CODY', purchase_order_item_id: 'poi-1' },
        { id: 'gi-x', company_id: 2, grn_id: 'grn-x', supplier_sku: 'THEIRS', purchase_order_item_id: null },
      ],
      grns: [{ id: 'grn-1', company_id: 1, grn_number: 'HC-GRN-000610', warehouse_id: 'wh-kl' }],
      poLines: [{ id: 'poi-1', company_id: 1, purchase_order_id: 'po-1', so_item_id: null }],
      pos: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-009951', linked_ac_docno: 'PO-009951' }],
    }).request('/export/rows');
    const body = (await res.json()) as Body;
    const lines = body.purchaseInvoices[0]!.lines;
    expect(lines.map((l) => l.id)).not.toContain(planted.id);
    const byId = new Map(lines.map((l) => [l.id, l]));
    expect(byId.get(mine.id)).toMatchObject({ supplier_sku: 'DG-CODY', grn_no: 'HC-GRN-000610', location: 'KL', our_po_no: 'PO-009951', po_no: 'HC-PO-009951', unit_price_sen: 50000 });
    expect(byId.get(theirs.id)).toMatchObject({ supplier_sku: null, grn_no: null, location: null });
  });
});
