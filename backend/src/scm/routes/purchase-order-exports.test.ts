// GET /mfg-purchase-orders/export/lines and /export/headers — the Purchase
// Order list's exports over EVERY page its filters match (owner 2026-09-15).
//
// Harness follows changeLogRoute.test.ts: a bare Hono app whose middleware
// injects the fake PostgREST client and a company context, mounting the
// EXPORTED handlers (the supabaseAuth bridge cannot run here).
//
// WHAT IS ASSERTED is the owner's requirement:
//   1. The export follows the list's tab, search and sort — the SAME filter the
//      list builds (lib/po-list-read.ts), not a copy of it.
//   2. It holds every matching order, past PostgREST's response ceiling — the
//      old Export held one screen page.
//   3. Company scope holds on the header AND the line read, and the paired
//      same-company request still returns rows.
//   4. One row per line, in the column contract's order, with the estimate
//      dates falling back to the PO header.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { PO_LINE_EXPORT_COLUMNS } from '../lib/po-line-export-columns';
import { poHeaderExportHandler, poLineExportHandler } from './purchase-order-exports';

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
    item_group: 'sofa',
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
  app.get('/export/lines', poLineExportHandler);
  app.get('/export/headers', poHeaderExportHandler);
  return app;
}

type LinesBody = {
  error?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  poCount: number;
  lineCount: number;
  truncated: boolean;
};

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const col = (body: LinesBody, name: (typeof PO_LINE_EXPORT_COLUMNS)[number]) => {
  const i = body.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return body.rows.map((r) => r[i]);
};

describe('the line export follows the list filters', () => {
  it('holds only the tab the list is on (open = SUBMITTED)', async () => {
    const open = po({ status: 'SUBMITTED' });
    const received = po({ status: 'RECEIVED' });
    const app = harness({ pos: [open, received], lines: [line(open), line(received)] });
    const { status, body } = await getLines(app, '?status=open');
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual([open.po_number]);
    expect(col(body, 'Status')).toEqual(['Submitted']);
  });

  it('applies the search box to the PO number and notes', async () => {
    const hit = po({ po_number: 'HC-PO-009949' });
    const noted = po({ notes: 'rush for 009949 customer' });
    const miss = po({ po_number: 'HC-PO-001000' });
    const app = harness({ pos: [hit, noted, miss], lines: [line(hit), line(noted), line(miss)] });
    const { body } = await getLines(app, '?q=009949');
    expect(new Set(col(body, 'Doc No'))).toEqual(new Set([hit.po_number, noted.po_number]));
  });

  it('reads the on-hold MARKER for the On Hold tab', async () => {
    const held = po({ on_hold: true });
    const live = po();
    const app = harness({ pos: [held, live], lines: [line(held), line(live)] });
    const { body } = await getLines(app, '?status=on_hold');
    expect(col(body, 'Doc No')).toEqual([held.po_number]);
  });

  it('orders documents by the list sort, and lines by their position on the PO', async () => {
    const a = po({ po_number: 'HC-PO-000001' });
    const b = po({ po_number: 'HC-PO-000002' });
    const app = harness({
      pos: [b, a],
      lines: [
        line(b, { line_no: 2, item_code: 'B-2' }),
        line(a, { line_no: 1, item_code: 'A-1' }),
        line(b, { line_no: 1, item_code: 'B-1' }),
      ],
    });
    const { body } = await getLines(app, '?sort=po_number:asc');
    expect(col(body, 'Item Code')).toEqual(['A-1', 'B-1', 'B-2']);
    const desc = await getLines(app, '?sort=po_number:desc');
    expect(col(desc.body, 'Item Code')).toEqual(['B-1', 'B-2', 'A-1']);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const pos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_205; i += 1) {
      const p = po();
      pos.push(p);
      lines.push(line(p));
    }
    // The fake answers at most 1,000 rows per request, like the real edge.
    const app = harness({ pos, lines }, 1, 1_000);
    const { status, body } = await getLines(app, '?status=open');
    expect(status).toBe(200);
    expect(body.poCount).toBe(1_205);
    expect(body.lineCount).toBe(1_205);
    expect(body.rows).toHaveLength(1_205);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_205);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s orders or lines, and still exports its own', async () => {
    const mine = po({ company_id: 1 });
    const theirs = po({ company_id: 2, po_number: 'HC-PO-THEIRS' });
    /* A line of company 2 hanging off company 1's PO id: a parent predicate is
       not company scope (R105 b), so it must not ride along. */
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { pos: [mine, theirs], lines: [line(mine), line(theirs), planted] };

    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual([mine.po_number]);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');

    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['HC-PO-THEIRS']);
  });

  it('does not print another company\'s sales order number on a line', async () => {
    const p = po();
    const tables = {
      pos: [p],
      lines: [line(p, { so_item_id: 'soi-1' }), line(p, { so_item_id: 'soi-2', line_no: 2 })],
      so: [
        { id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' },
        { id: 'soi-2', company_id: 2, doc_no: '2990-SO-000001' },
      ],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'SO Doc No.')).toEqual(['HC-SO-013389', null]);
  });
});

describe('one row per line, in the contract order', () => {
  it('shapes the cells, with estimate dates falling back to the PO header', async () => {
    const p = po({
      po_number: 'HC-PO-009950',
      linked_ac_docno: 'PO-2609-011',
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
    const app = harness({ pos: [p], lines: [l], so: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' }] });
    const { body } = await getLines(app);
    expect(body.columns).toEqual([...PO_LINE_EXPORT_COLUMNS]);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-PO-009950',
      'AutoCount Doc No': 'PO-2609-011',
      'Doc Date': '2026-09-01',
      'Status': 'Submitted',
      'Supplier Code': '400-D001',
      'Supplier Name': 'DIGLANT MANUFACTURING SDN BHD.',
      'SO Doc No.': 'HC-SO-013389',
      'Item Code': '9058-1A(LHF)',
      'Supplier SKU': 'DG-9058',
      'Item Description': '9058 SOFA 1A LHF',
      'Item Description 2': 'FABRIC KN-12 / SEAT 18',
      'Remarks': 'call before delivery',
      'Category': 'sofa',
      'Location': 'PG', // AutoCount's short code, as the book spells it
      'Qty': 3,
      'Received Qty': 1,
      'Remaining Qty': 2,
      'Unit Price': 0.055,
      'Line Total': 16.5,
      'Delivery Date': '2026-09-20',
      'Estimate Delivery Date 1': '2026-09-12', // header: the line is blank
      'Estimate Delivery Date 2': '2026-09-25', // the line wins over the header
      'Estimate Delivery Date 3': '2026-10-01',
      'Line ID': l.id,
    });
  });

  it('prints the PO header warehouse when the line has none, as the short code', async () => {
    const p = po({ purchase_location_id: 'wh-kl' });
    const { body } = await getLines(harness({ pos: [p], lines: [line(p, { warehouse_id: null })] }));
    expect(col(body, 'Location')).toEqual(['KL']);
  });

  it('writes the word the list shows, with the hold marker after it', async () => {
    const held = po({ status: 'SUBMITTED', on_hold: true });
    const partial = po({ status: 'PARTIALLY_RECEIVED', po_number: 'HC-PO-ZZZZZZ' });
    const { body } = await getLines(harness({ pos: [held, partial], lines: [line(held), line(partial)] }), '?sort=po_number:asc');
    expect(col(body, 'Status')).toEqual(['Submitted (On Hold)', 'Partially received']);
  });

  it('carries cancelled orders only when the tab includes them', async () => {
    const live = po({ status: 'SUBMITTED' });
    const cancelled = po({ status: 'CANCELLED' });
    const tables = { pos: [live, cancelled], lines: [line(live), line(cancelled)] };
    const all = await getLines(harness(tables));
    expect(new Set(col(all.body, 'Status'))).toEqual(new Set(['Submitted', 'Cancelled']));
    const open = await getLines(harness(tables), '?status=open');
    expect(col(open.body, 'Status')).toEqual(['Submitted']);
    const outstanding = await getLines(harness(tables), '?status=outstanding');
    expect(col(outstanding.body, 'Status')).not.toContain('Cancelled');
  });
});

describe('the header export', () => {
  it('returns every matching order in the list row shape, GRN stamp included', async () => {
    const pos: Row[] = [];
    for (let i = 0; i < 1_050; i += 1) pos.push(po());
    const cancelledPo = po({ status: 'CANCELLED' });
    const grns = [{ id: 'grn-1', purchase_order_id: pos[0]!.id, grn_number: 'HC-GR-000001', status: 'POSTED' }];
    const app = harness({ pos: [...pos, cancelledPo], lines: [], grns }, 1, 1_000);
    const res = await app.request('/export/headers?status=open');
    const body = (await res.json()) as {
      purchaseOrders: Array<Row & { has_children: boolean; transfer_to_grns: unknown[] }>;
      total: number;
      truncated: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_050);
    expect(body.purchaseOrders.map((r) => r.id)).not.toContain(cancelledPo.id);
    const first = body.purchaseOrders.find((r) => r.id === pos[0]!.id)!;
    expect(first.has_children).toBe(true);
    expect(first.transfer_to_grns).toEqual([{ id: 'grn-1', grnNumber: 'HC-GR-000001' }]);
  });
});
