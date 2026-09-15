// GET /grns/export/rows — every Goods Received note the list's filter matches,
// each carrying its lines, for the grid-driven export (owner 2026-09-15: one
// Export, one row per line, the grid's visible columns, AutoCount's spelling).
// Harness as grn-exports.test.ts.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';
import { fakeSb } from '../lib/fake-postgrest';
import { grnExportRowsHandler } from './grn-exports';

type Row = Record<string, unknown>;
let seq = 0;
const grn = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `grn-${String(seq).padStart(5, '0')}`, company_id: 1, grn_number: `HC-GRN-${String(seq).padStart(6, '0')}`,
    received_at: '2026-09-01', status: 'POSTED', on_hold: false, notes: null, delivery_note_ref: null, currency: 'MYR',
    supplier_id: 'sup-1', supplier: { code: '400-D001', name: 'DIGLANT' }, warehouse_id: 'wh-kl', total_sen: 0,
    linked_ac_docno: null, linked_ac_gr_docno: null, migrated_no_stock: false, ...over,
  };
};
const line = (g: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `gi-${String(seq).padStart(5, '0')}`, grn_id: g.id, company_id: g.company_id, created_at: '2026-09-01T00:00:00Z',
    purchase_order_item_id: null, item_code: 'CODY-(K)', supplier_sku: null, material_name: 'CODY KING', description: null,
    description2: null, notes: null, item_group: 'mattress', uom: 'UNIT', qty_received: 4, qty_accepted: 4, qty_rejected: 0,
    returned_qty: 0, unit_price_sen: 45000, discount_sen: 0, line_total_sen: 180000, delivery_date: null, variants: null, ...over,
  };
};

type Tables = { grns: Row[]; lines: Row[]; poLines?: Row[]; pos?: Row[]; so?: Row[]; piLines?: Row[]; pis?: Row[]; bindings?: Row[] };
function app(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    grns: t.grns, grn_items: t.lines, purchase_order_items: t.poLines ?? [], purchase_orders: t.pos ?? [],
    mfg_sales_order_items: t.so ?? [], purchase_invoice_items: t.piLines ?? [], purchase_invoices: t.pis ?? [],
    supplier_material_bindings: t.bindings ?? [],
    warehouses: [{ id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG' }, { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG' }],
  }, {}, [], [], maxRows);
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    await next();
  });
  a.get('/export/rows', grnExportRowsHandler);
  return a;
}
type Body = { grns: Array<Row & { ac_doc_no: string | null; lines: Row[] }>; total: number; lineCount: number; truncated: boolean };
const get = async (a: ReturnType<typeof app>, qs = '') => {
  const res = await a.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('GET /grns/export/rows', () => {
  it('holds every receipt of the tab past the ceiling, each carrying its lines', async () => {
    const grns: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_010; i += 1) {
      const g = grn();
      grns.push(g);
      lines.push(line(g), line(g));
    }
    const draft = grn({ status: 'DRAFT' });
    const { status, body } = await get(app({ grns: [...grns, draft], lines: [...lines, line(draft)] }, 1, 1_000), '?status=posted');
    expect(status).toBe(200);
    expect(body.total).toBe(1_010);
    expect(body.lineCount).toBe(2_020);
    expect(body.grns.every((g) => g.lines.length === 2)).toBe(true);
    expect(body.grns.map((g) => g.id)).not.toContain(draft.id);
    expect(body.truncated).toBe(false);
  });

  it('keeps another company\'s receipts, lines and invoice lines out', async () => {
    const mine = grn();
    const l = line(mine, { qty_accepted: 5 });
    const planted = line(mine, { company_id: 2 });
    const { body } = await get(app({
      grns: [mine, grn({ company_id: 2 })],
      lines: [l, planted],
      piLines: [{ id: 'x', company_id: 2, purchase_invoice_id: 'pi-x', grn_item_id: l.id, qty: 5 }],
      pis: [{ id: 'pi-x', company_id: 2, invoice_number: '2990-PI-1', status: 'POSTED' }],
    }));
    expect(body.grns.map((g) => g.id)).toEqual([mine.id]);
    expect(body.grns[0]!.lines.map((x) => x.id)).toEqual([l.id]);
    expect(body.grns[0]!.lines[0]!.invoiced_qty).toBe(0);
  });

  it('spells the values the way AutoCount\'s listing does', async () => {
    const g = grn({ migrated_no_stock: true, linked_ac_docno: 'PO-009951', linked_ac_gr_docno: 'GR-005334', warehouse_id: 'wh-pg' });
    const l = line(g, { item_code: 'ZZ-TEST-1', description2: 'typed text', purchase_order_item_id: 'poi-1', qty_accepted: 4, returned_qty: 1, notes: 'dented' });
    const { body } = await get(app({
      grns: [g],
      lines: [l],
      poLines: [{ id: 'poi-1', company_id: 1, purchase_order_id: 'po-1', so_item_id: 'soi-1' }],
      pos: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-009951', linked_ac_docno: 'PO-009951' }],
      so: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' }],
      piLines: [
        { id: 'p1', company_id: 1, purchase_invoice_id: 'pi-1', grn_item_id: l.id, qty: 2 },
        { id: 'p2', company_id: 1, purchase_invoice_id: 'pi-d', grn_item_id: l.id, qty: 1 },
      ],
      pis: [
        { id: 'pi-1', company_id: 1, invoice_number: 'HC-PI-1', status: 'POSTED' },
        { id: 'pi-d', company_id: 1, invoice_number: 'HC-PI-2', status: 'DRAFT' },
      ],
      bindings: [{ id: 'b1', company_id: 1, material_kind: 'mfg_product', item_code: 'ZZ-TEST-1', supplier_id: 'sup-1', supplier_sku: 'AK-ZZ TEST', ac_item_code: null, is_main_supplier: true }],
    }));
    const row = body.grns[0]!;
    expect(row.ac_doc_no).toBe('GR-005334');
    expect(row.lines[0]).toMatchObject({
      item_code: 'ZZ-TEST-1',
      ac_item_code: 'AK-ZZ TEST', // the live binding, through resolveAcItemCode
      description2: 'typed text', // no variants to compose from: the stored text
      remarks: 'dented',
      location: 'PG',
      qty: 4,
      invoiced_qty: 2, // the DRAFT invoice bills nothing
      returned_qty: 1,
      uninvoiced_qty: 1,
      po_no: 'HC-PO-009951',
      our_po_no: 'PO-009951',
      so_doc_no: 'HC-SO-013389',
      invoice_nos: 'HC-PI-1',
      unit_price_sen: 45000,
    });
  });

  it('composes Detail Description 2 from the variants when they say something', async () => {
    const g = grn();
    const l = line(g, { item_group: 'sofa', variants: { fabricCode: 'BO315-25' }, description2: 'typed text' });
    const { body } = await get(app({ grns: [g], lines: [l] }));
    expect(body.grns[0]!.lines[0]!.description2).toBe('BO315-25');
  });
});
