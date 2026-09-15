// GET /delivery-orders-mfg/export/lines — the Delivery Order list's line export
// over EVERY page its filters match, with NO prices (owner 2026-09-15).
//
// Harness follows purchase-order-exports.test.ts. What is asserted:
//   1. The export follows the list's tab and search (lib/do-list-read.ts).
//   2. It holds every matching delivery order past the response ceiling.
//   3. Company scope on the header AND the line read; the same-company request
//      still returns rows.
//   4. One row per line, no money column, the app's own invoiced / uninvoiced
//      ledger, the list's status word, the Malaysian day it was delivered.
//   5. The list's refusal for a caller with no Houzs identity.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { DO_LINE_EXPORT_COLUMNS } from '../lib/do-line-export-columns';
import { doLineExportHandler } from './delivery-order-exports';

type Row = Record<string, unknown>;

let seq = 0;
const dOrder = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `do-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    do_number: `HC-DO-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null,
    do_date: '2026-09-01',
    status: 'DELIVERED',
    on_hold: false,
    debtor_code: '300-A001',
    debtor_name: 'ALICE TAN',
    ref: null,
    customer_so_no: null,
    so_doc_no: 'HC-SO-013389',
    customer_delivery_date: '2026-09-05',
    expected_delivery_at: null,
    delivered_at: null,
    branding: 'ZANOTTI',
    venue: null,
    driver_name: null,
    vehicle: null,
    phone: '60123456789',
    address1: '9 JALAN DELIVER',
    address2: null,
    city: 'PUCHONG',
    postcode: '47100',
    state: 'SELANGOR',
    warehouse_id: null,
    sales_location: 'KL',
    salesperson_id: null,
    agent: null,
    ...over,
  };
};

const doLine = (d: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `dol-${String(seq).padStart(5, '0')}`,
    delivery_order_id: d.id,
    company_id: d.company_id,
    line_no: 1,
    created_at: '2026-09-01T00:00:00Z',
    item_code: 'ZN-5530-3S',
    description: 'ZANOTTI 5530 3 SEATER',
    description2: null,
    notes: null,
    item_group: 'sofa',
    uom: 'UNIT',
    qty: 2,
    m3_milli: 1850,
    line_delivery_date: null,
    so_item_id: null,
    unit_price_sen: 250000,
    line_total_sen: 500000,
    ...over,
  };
};

type Tables = { dos: Row[]; lines: Row[]; siLines?: Row[]; sis?: Row[]; soLines?: Row[]; staff?: Row[] };

function harness(t: Tables, companyId = 1, maxRows: number | null = null, houzsUser: unknown = { id: 7, permissions_set: new Set(['*']) }) {
  const sb = fakeSb({
    delivery_orders: t.dos,
    delivery_order_items: t.lines,
    sales_invoice_items: t.siLines ?? [],
    sales_invoices: t.sis ?? [],
    delivery_return_items: [],
    delivery_returns: [],
    mfg_sales_order_items: t.soLines ?? [],
    warehouses: [{ id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }],
    staff: t.staff ?? [],
  }, {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    if (houzsUser) c.set('houzsUser', houzsUser as Variables['houzsUser']);
    await next();
  });
  app.get('/export/lines', doLineExportHandler);
  return app;
}

type LinesBody = {
  error?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  doCount: number;
  lineCount: number;
  truncated: boolean;
};

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const col = (body: LinesBody, name: (typeof DO_LINE_EXPORT_COLUMNS)[number]) => {
  const i = body.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return body.rows.map((r) => r[i]);
};

describe('the line export follows the list filters', () => {
  it('holds the tab (delivered = SIGNED + DELIVERED) and nothing else', async () => {
    const signed = dOrder({ status: 'SIGNED', do_number: 'HC-DO-A' });
    const delivered = dOrder({ status: 'DELIVERED', do_number: 'HC-DO-B' });
    const loaded = dOrder({ status: 'LOADED', do_number: 'HC-DO-C' });
    const app = harness({ dos: [signed, delivered, loaded], lines: [doLine(signed), doLine(delivered), doLine(loaded)] });
    const { status, body } = await getLines(app, '?status=delivered&sort=do_number:asc');
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual(['HC-DO-A', 'HC-DO-B']);
    const confirmed = await getLines(app, '?status=loaded');
    expect(col(confirmed.body, 'Status')).toEqual(['Confirmed']); // LOADED reads "Confirmed" on the list
  });

  it('applies the search box', async () => {
    const hit = dOrder({ debtor_name: 'BOB LIM' });
    const miss = dOrder();
    const { body } = await getLines(harness({ dos: [hit, miss], lines: [doLine(hit), doLine(miss)] }), '?q=bob');
    expect(col(body, 'Doc No')).toEqual([hit.do_number]);
  });

  it('carries cancelled delivery orders only when the tab includes them', async () => {
    const live = dOrder();
    const cancelled = dOrder({ status: 'CANCELLED' });
    const tables = { dos: [live, cancelled], lines: [doLine(live), doLine(cancelled)] };
    expect(new Set(col((await getLines(harness(tables))).body, 'Status'))).toEqual(new Set(['Delivered', 'Cancelled']));
    expect(col((await getLines(harness(tables), '?status=delivered')).body, 'Status')).toEqual(['Delivered']);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const dos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) {
      const d = dOrder();
      dos.push(d);
      lines.push(doLine(d));
    }
    const { status, body } = await getLines(harness({ dos, lines }, 1, 1_000));
    expect(status).toBe(200);
    expect(body.doCount).toBe(1_105);
    expect(body.lineCount).toBe(1_105);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_105);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s delivery orders or lines, and still exports its own', async () => {
    const mine = dOrder({ company_id: 1 });
    const theirs = dOrder({ company_id: 2, do_number: '2990-DO-000001' });
    const planted = doLine(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { dos: [mine, theirs], lines: [doLine(mine), doLine(theirs), planted] };
    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual([mine.do_number]);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');
    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['2990-DO-000001']);
  });

  it('refuses a caller with no Houzs identity, as the list does', async () => {
    const d = dOrder();
    const { status } = await getLines(harness({ dos: [d], lines: [doLine(d)] }, 1, null, null));
    expect(status).toBe(403);
  });
});

describe('one row per line, no prices', () => {
  it('carries no price or amount column', async () => {
    const d = dOrder();
    const { body } = await getLines(harness({ dos: [d], lines: [doLine(d)] }));
    expect(body.columns).toEqual([...DO_LINE_EXPORT_COLUMNS]);
    expect(body.columns.filter((c) => /price|amount|total|discount|balance/i.test(c))).toEqual([]);
    expect(body.rows[0]).not.toContain(2500);
    expect(body.rows[0]).not.toContain(5000);
  });

  it('shapes the cells from the app\'s own rules', async () => {
    const d = dOrder({
      do_number: 'HC-DO-000210', linked_ac_docno: 'DO-2609-0100', status: 'DELIVERED', on_hold: true,
      ref: 'CUST-77', warehouse_id: 'wh-kl', salesperson_id: 'staff-1', expected_delivery_at: '2026-09-04',
      delivered_at: '2026-09-10T17:30:00Z', // 01:30 on the 11th in Kuala Lumpur
    });
    const l = doLine(d, { qty: 3, so_item_id: 'soi-1', notes: 'lift', description2: 'FABRIC KN-12', line_delivery_date: '2026-09-06' });
    const siLines = [
      { id: 'sil-1', company_id: 1, do_item_id: l.id, sales_invoice_id: 'si-1', qty: 1 },
      { id: 'sil-2', company_id: 1, do_item_id: l.id, sales_invoice_id: 'si-2', qty: 1 },
    ];
    const sis = [
      { id: 'si-1', company_id: 1, invoice_number: 'HC-IV-000050', status: 'SENT' },
      { id: 'si-2', company_id: 1, invoice_number: 'HC-IV-000049', status: 'CANCELLED' },
    ];
    const app = harness({
      dos: [d], lines: [l], siLines, sis,
      soLines: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013390' }],
      staff: [{ id: 'staff-1', name: 'WEI SIANG', staff_code: 'WS' }],
    });
    const { body } = await getLines(app);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-DO-000210',
      'AutoCount Doc No': 'DO-2609-0100',
      'Doc Date': '2026-09-01',
      'Status': 'Delivered (On Hold)',
      'Customer Code': '300-A001',
      'Customer Name': 'ALICE TAN',
      'Customer Ref': 'CUST-77',
      'Item Code': 'ZN-5530-3S',
      'Item Description': 'ZANOTTI 5530 3 SEATER',
      'Item Description 2': 'FABRIC KN-12',
      'Remarks': 'lift',
      'Category': 'sofa',
      'Location': 'KL',
      'UOM': 'UNIT',
      'Qty': 3,
      'Invoiced Qty': 1, // the cancelled invoice does not count
      'Returned Qty': 0,
      'Uninvoiced Qty': 2,
      'm³': 1.85,
      'Delivery Date': '2026-09-06',
      'Expected Delivery': '2026-09-04',
      'Delivered On': '2026-09-11',
      'Salesperson': 'WEI SIANG',
      'Branding': 'ZANOTTI',
      'Venue': null,
      'Driver': null,
      'Vehicle': null,
      'Phone': '60123456789',
      'Delivery Address': '9 JALAN DELIVER, PUCHONG, 47100',
      'State': 'SELANGOR',
      'SO Doc No.': 'HC-SO-013390', // the line's own order wins over the header label
      'Invoice No.': 'HC-IV-000050',
      'Line ID': l.id,
    });
  });

  it('leaves the invoicing columns blank on a delivery order outside the ledger (DRAFT)', async () => {
    const d = dOrder({ status: 'DRAFT', sales_location: 'PG' });
    const { body } = await getLines(harness({ dos: [d], lines: [doLine(d)] }));
    expect(col(body, 'Invoiced Qty')).toEqual([null]);
    expect(col(body, 'Uninvoiced Qty')).toEqual([null]);
    expect(col(body, 'Location')).toEqual(['PG']);
    expect(col(body, 'SO Doc No.')).toEqual(['HC-SO-013389']);
  });
});
