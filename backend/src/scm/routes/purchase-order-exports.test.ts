// GET /mfg-purchase-orders/export/rows — every purchase order the list's filters
// match (all pages), each with its lines, for the grid-driven export (owner
// 2026-09-15: one row per line, the columns the grid shows, its filter and view).
//
// Harness follows changeLogRoute.test.ts: a bare Hono app whose middleware
// injects the fake PostgREST client and a company context, mounting the
// EXPORTED handler (the supabaseAuth bridge cannot run here).
//
// WHAT IS ASSERTED is the owner's requirement:
//   1. The read follows the list's tab, search and sort — the SAME filter the
//      list builds (lib/po-list-read.ts), not a copy of it.
//   2. It holds every matching order, past PostgREST's response ceiling.
//   3. Company scope holds on the header, line AND sales-order read, and the
//      paired same-company request still returns rows.
//   4. Each line carries the AutoCount-listing values: supplier item code,
//      short location, estimate dates (line, else header), Item Description 2
//      from the variants (stored text only as the fallback), remaining qty.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import type { PoListLine } from '../lib/po-line-export-columns';
import { poExportRowsHandler } from './purchase-order-exports';

type Row = Record<string, unknown>;

let seq = 0;
const po = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `po-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    po_number: `HC-PO-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null,
    po_date: '2026-09-01',
    status: 'SUBMITTED',
    notes: null,
    on_hold: false,
    supplier_id: 'sup-1',
    supplier: { code: '400-D001', name: 'DIGLANT MANUFACTURING SDN BHD.' },
    purchase_location_id: 'wh-kl',
    supplier_delivery_date_2: null,
    supplier_delivery_date_3: null,
    supplier_delivery_date_4: null,
    ...over,
  };
};

const line = (poRow: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `line-${String(seq).padStart(5, '0')}`,
    purchase_order_id: poRow.id,
    company_id: poRow.company_id,
    line_no: 1,
    created_at: '2026-09-01T00:00:00Z',
    item_code: '9058-1A(LHF)',
    supplier_sku: 'DG-9058',
    material_name: '9058 SOFA 1A LHF',
    description2: 'FABRIC KN-12 / SEAT 18',
    notes: null,
    item_group: 'accessory',
    variants: null,
    warehouse_id: null,
    qty: 2,
    received_qty: 0,
    unit_price_sen: 45000,
    line_total_sen: 90000,
    delivery_date: '2026-09-20',
    supplier_delivery_date_2: null,
    supplier_delivery_date_3: null,
    supplier_delivery_date_4: null,
    so_item_id: null,
    ...over,
  };
};

function harness(tables: { pos: Row[]; lines: Row[]; so?: Row[]; grns?: Row[] }, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    purchase_orders: tables.pos,
    purchase_order_items: tables.lines,
    mfg_sales_order_items: tables.so ?? [],
    warehouses: [
      { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
      { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
    ],
    grns: tables.grns ?? [],
  }, {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    await next();
  });
  app.get('/export/rows', poExportRowsHandler);
  return app;
}

type Body = {
  error?: string;
  purchaseOrders: Array<Row & { lines: PoListLine[]; has_children?: boolean; transfer_to_grns?: unknown[] }>;
  total: number;
  lineCount: number;
  truncated: boolean;
};

const get = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

const docNos = (b: Body) => b.purchaseOrders.map((r) => r.po_number);
const allLines = (b: Body) => b.purchaseOrders.flatMap((r) => r.lines);

describe('the export read follows the list filters', () => {
  it('holds only the tab the list is on (open = SUBMITTED)', async () => {
    const open = po({ status: 'SUBMITTED' });
    const received = po({ status: 'RECEIVED' });
    const { status, body } = await get(harness({ pos: [open, received], lines: [line(open), line(received)] }), '?status=open');
    expect(status).toBe(200);
    expect(docNos(body)).toEqual([open.po_number]);
  });

  it('applies the search box to the PO number and notes', async () => {
    const hit = po({ po_number: 'HC-PO-009949' });
    const noted = po({ notes: 'rush for 009949 customer' });
    const miss = po({ po_number: 'HC-PO-001000' });
    const { body } = await get(harness({ pos: [hit, noted, miss], lines: [] }), '?q=009949');
    expect(new Set(docNos(body))).toEqual(new Set([hit.po_number, noted.po_number]));
  });

  it('reads the on-hold MARKER for the On Hold tab', async () => {
    const held = po({ on_hold: true });
    const live = po();
    const { body } = await get(harness({ pos: [held, live], lines: [] }), '?status=on_hold');
    expect(docNos(body)).toEqual([held.po_number]);
  });

  it('carries cancelled orders only when the tab includes them', async () => {
    const live = po({ status: 'SUBMITTED' });
    const cancelled = po({ status: 'CANCELLED' });
    const tables = { pos: [live, cancelled], lines: [] };
    expect(new Set(docNos((await get(harness(tables))).body))).toEqual(new Set([live.po_number, cancelled.po_number]));
    expect(docNos((await get(harness(tables), '?status=outstanding')).body)).toEqual([live.po_number]);
  });

  it('orders documents by the list sort, and lines by their position on the PO', async () => {
    const a = po({ po_number: 'HC-PO-000001' });
    const b = po({ po_number: 'HC-PO-000002' });
    const tables = {
      pos: [b, a],
      lines: [
        line(b, { line_no: 2, supplier_sku: 'B-2' }),
        line(a, { line_no: 1, supplier_sku: 'A-1' }),
        line(b, { line_no: 1, supplier_sku: 'B-1' }),
      ],
    };
    const asc = await get(harness(tables), '?sort=po_number:asc');
    expect(allLines(asc.body).map((l) => l.supplier_sku)).toEqual(['A-1', 'B-1', 'B-2']);
    const desc = await get(harness(tables), '?sort=po_number:desc');
    expect(allLines(desc.body).map((l) => l.supplier_sku)).toEqual(['B-1', 'B-2', 'A-1']);
  });

  it('keeps a purchase order with no lines, with an empty line list', async () => {
    const empty = po();
    const { body } = await get(harness({ pos: [empty], lines: [] }));
    expect(body.purchaseOrders).toHaveLength(1);
    expect(body.purchaseOrders[0]!.lines).toEqual([]);
  });
});

describe('every page, not the screen page', () => {
  it('returns every order and line past the PostgREST response ceiling', async () => {
    const pos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_205; i += 1) {
      const p = po();
      pos.push(p);
      lines.push(line(p));
    }
    const grns = [{ id: 'grn-1', purchase_order_id: pos[0]!.id, grn_number: 'HC-GR-000001', status: 'POSTED' }];
    const { status, body } = await get(harness({ pos, lines, grns }, 1, 1_000), '?status=open');
    expect(status).toBe(200);
    expect(body.total).toBe(1_205);
    expect(body.lineCount).toBe(1_205);
    expect(new Set(allLines(body).map((l) => l.id)).size).toBe(1_205);
    expect(body.truncated).toBe(false);
    const first = body.purchaseOrders.find((r) => r.id === pos[0]!.id)!;
    expect(first.has_children).toBe(true);
    expect(first.transfer_to_grns).toEqual([{ id: 'grn-1', grnNumber: 'HC-GR-000001' }]);
  });
});

describe('company scope', () => {
  it("never reads another company's orders or lines, and still reads its own", async () => {
    const mine = po({ company_id: 1 });
    const theirs = po({ company_id: 2, po_number: 'HC-PO-THEIRS' });
    /* A line of company 2 hanging off company 1's PO id: a parent predicate is
       not company scope (R105 b), so it must not ride along. */
    const planted = line(mine, { company_id: 2, supplier_sku: 'PLANTED' });
    const tables = { pos: [mine, theirs], lines: [line(mine), line(theirs), planted] };

    const one = (await get(harness(tables, 1))).body;
    expect(docNos(one)).toEqual([mine.po_number]);
    expect(allLines(one).map((l) => l.supplier_sku)).not.toContain('PLANTED');

    const two = (await get(harness(tables, 2))).body;
    expect(docNos(two)).toEqual(['HC-PO-THEIRS']);
  });

  it("does not print another company's sales order number on a line", async () => {
    const p = po();
    const tables = {
      pos: [p],
      lines: [line(p, { so_item_id: 'soi-1' }), line(p, { so_item_id: 'soi-2', line_no: 2 })],
      so: [
        { id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' },
        { id: 'soi-2', company_id: 2, doc_no: '2990-SO-000001' },
      ],
    };
    const { body } = await get(harness(tables));
    expect(allLines(body).map((l) => l.so_doc_no)).toEqual(['HC-SO-013389', null]);
  });
});

describe('the line values', () => {
  it('carries the AutoCount-listing values for a line', async () => {
    const p = po({
      po_number: 'HC-PO-009950',
      linked_ac_docno: 'PO-009950',
      supplier_delivery_date_2: '2026-09-12',
      supplier_delivery_date_3: '2026-09-18',
    });
    const l = line(p, {
      warehouse_id: 'wh-pg',
      qty: 3,
      received_qty: 1,
      unit_price_sen: 5.5,
      line_total_sen: 1650,
      notes: 'call before delivery',
      supplier_delivery_date_3: '2026-09-25',
      supplier_delivery_date_4: '2026-10-01',
      so_item_id: 'soi-1',
    });
    const { body } = await get(harness({ pos: [p], lines: [l], so: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' }] }));
    expect(body.purchaseOrders[0]!.linked_ac_docno).toBe('PO-009950');
    expect(body.purchaseOrders[0]!.lines).toEqual([{
      id: String(l.id),
      line_no: 1,
      item_code: '9058-1A(LHF)',
      material_name: '9058 SOFA 1A LHF',
      item_description: '9058 SOFA 1A LHF', // DG-9058 is not in the book's item master: the ERP name
      description2: 'FABRIC KN-12 / SEAT 18',
      notes: 'call before delivery',
      item_group: 'accessory',
      ac_item_group: 'ACC',
      supplier_sku: 'DG-9058',
      qty: 3,
      received_qty: 1,
      remaining_qty: 2,
      unit_price_sen: 5.5,
      line_total_sen: 1650,
      delivery_date: '2026-09-20',
      estimate_delivery_date_1: '2026-09-12', // header: the line is blank
      estimate_delivery_date_2: '2026-09-25', // the line wins over the header
      estimate_delivery_date_3: '2026-10-01',
      location: 'PG', // AutoCount's short code, as the book spells it
      so_doc_no: 'HC-SO-013389',
    } satisfies PoListLine]);
  });

  it('prints the PO header warehouse when the line has none, as the short code', async () => {
    const p = po({ purchase_location_id: 'wh-kl' });
    const { body } = await get(harness({ pos: [p], lines: [line(p, { warehouse_id: null })] }));
    expect(allLines(body)[0]!.location).toBe('KL');
  });

  it('Item Description 2 is composed from the variants; the stored text is only the fallback', async () => {
    const p = po();
    const spec = line(p, { item_group: 'bedframe', variants: { fabricCode: 'PC151-04' }, description2: 'OLD TYPED TEXT' });
    const none = line(p, { line_no: 2, item_group: 'accessory', variants: null, description2: 'KEPT' });
    const { body } = await get(harness({ pos: [p], lines: [spec, none] }));
    const [a, b] = allLines(body);
    expect(a!.description2).not.toBe('OLD TYPED TEXT');
    expect(a!.description2).toContain('PC151-04');
    expect(b!.description2).toBe('KEPT');
  });
});
