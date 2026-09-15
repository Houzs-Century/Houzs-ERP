// GET /mfg-sales-orders/export/lines — the Sales Order list's line export over
// EVERY page its filters match (owner 2026-09-15).
//
// Harness follows purchase-order-exports.test.ts: a bare Hono app whose
// middleware injects the fake PostgREST client, a company and a view-all caller,
// mounting the EXPORTED handler (the supabaseAuth bridge cannot run here).
//
// WHAT IS ASSERTED is the owner's requirement:
//   1. The export follows the list's tab, search AND second-level filter rows
//      (`f`) — the SAME predicate set the list builds (lib/so-list-read.ts).
//   2. It holds every matching order, past PostgREST's response ceiling.
//   3. Company scope holds on the header AND the line read (a doc number is not
//      company scope), and the paired same-company request still returns rows.
//   4. One row per line, in the contract's order: the list's status word, the
//      app's own delivered / remaining reading, AutoCount's short location code.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { SO_LINE_EXPORT_COLUMNS } from '../lib/so-line-export-columns';
import { soLineExportHandler } from './sales-order-exports';

type Row = Record<string, unknown>;

let seq = 0;
const so = (over: Row = {}): Row => {
  seq += 1;
  return {
    doc_no: `HC-SO-${String(seq).padStart(6, '0')}`,
    company_id: 1,
    so_date: '2026-08-10',
    status: 'CONFIRMED',
    on_hold: false,
    debtor_code: '300-A001',
    debtor_name: 'ALICE TAN',
    ref: null,
    customer_so_no: null,
    branding: 'ZANOTTI',
    venue: 'IOI CITY MALL',
    sales_location: 'KL',
    phone: '60123456789',
    address1: '1 JALAN A',
    address2: null,
    address3: null,
    address4: null,
    customer_state: 'SELANGOR',
    customer_delivery_date: '2026-09-30',
    processing_date: null,
    salesperson_id: null,
    agent: 'NICO',
    balance_sen: 100000,
    balance_sen_live: 40000,
    ...over,
  };
};

const soLine = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `soi-${String(seq).padStart(5, '0')}`,
    doc_no: h.doc_no,
    company_id: h.company_id,
    line_no: 1,
    created_at: '2026-08-10T00:00:00Z',
    item_code: 'ZN-5530-3S',
    description: 'ZANOTTI 5530 3 SEATER',
    description2: 'FABRIC KN-12',
    remark: null,
    item_group: 'sofa',
    uom: 'UNIT',
    location: 'KL',
    warehouse_id: null,
    qty: 1,
    stock_status: 'PENDING',
    unit_price_sen: 250000,
    discount_sen: 0,
    total_sen: 250000,
    line_delivery_date: null,
    cancelled: false,
    ...over,
  };
};

type Tables = {
  sos: Row[];
  lines: Row[];
  dos?: Row[];
  doLines?: Row[];
  poLines?: Row[];
  pos?: Row[];
  base?: Row[];
  staff?: Row[];
};

function harness(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    mfg_sales_orders_with_payment_totals: t.sos,
    mfg_sales_orders: t.base ?? t.sos.map((h) => ({ doc_no: h.doc_no, company_id: h.company_id, debtor_code: h.debtor_code, debtor_name: h.debtor_name, linked_ac_docno: null })),
    mfg_sales_order_items: t.lines,
    mfg_sales_order_payments: [],
    delivery_orders: t.dos ?? [],
    delivery_order_items: t.doLines ?? [],
    delivery_return_items: [],
    delivery_returns: [],
    sales_invoices: [],
    purchase_order_items: t.poLines ?? [],
    purchase_orders: t.pos ?? [],
    warehouses: [
      { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
      { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
    ],
    staff: t.staff ?? [],
  }, {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    c.set('houzsUser', { id: 7, permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/export/lines', soLineExportHandler);
  return app;
}

type LinesBody = {
  error?: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  soCount: number;
  lineCount: number;
  truncated: boolean;
};

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const col = (body: LinesBody, name: (typeof SO_LINE_EXPORT_COLUMNS)[number]) => {
  const i = body.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return body.rows.map((r) => r[i]);
};

describe('the line export follows the list filters', () => {
  it('holds the tab AND the second-level filter row', async () => {
    const aug = so({ so_date: '2026-08-10' });
    const sep = so({ so_date: '2026-09-10' });
    const delivered = so({ so_date: '2026-08-11', status: 'DELIVERED' });
    const app = harness({ sos: [aug, sep, delivered], lines: [soLine(aug), soLine(sep), soLine(delivered)] });
    const f = encodeURIComponent('orderDate:between:2026-08-01~2026-08-31');
    const { status, body } = await getLines(app, `?status=CONFIRMED&f=${f}`);
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual([aug.doc_no]);
    const noF = await getLines(app, '?status=CONFIRMED&sort=doc_no:asc');
    expect(col(noF.body, 'Doc No')).toEqual([aug.doc_no, sep.doc_no]);
  });

  it('applies the search box, the customer phone included', async () => {
    const hit = so({ phone: '60123456789' });
    const miss = so({ phone: '60190000000' });
    const app = harness({ sos: [hit, miss], lines: [soLine(hit), soLine(miss)] });
    const { body } = await getLines(app, `?q=${encodeURIComponent('012-345 6789')}`);
    expect(col(body, 'Doc No')).toEqual([hit.doc_no]);
  });

  it('refuses a filter row the list would refuse, rather than exporting everything', async () => {
    const h = so();
    const { status } = await getLines(harness({ sos: [h], lines: [soLine(h)] }), '?f=nonsense:is:x');
    expect(status).toBe(400);
  });

  it('carries cancelled orders only when the tab includes them', async () => {
    const live = so({ status: 'CONFIRMED' });
    const cancelled = so({ status: 'CANCELLED' });
    const tables = { sos: [live, cancelled], lines: [soLine(live), soLine(cancelled)] };
    const all = await getLines(harness(tables));
    expect(new Set(col(all.body, 'Status'))).toEqual(new Set(['Submitted', 'Cancelled']));
    const tab = await getLines(harness(tables), '?status=CONFIRMED');
    expect(col(tab.body, 'Status')).toEqual(['Submitted']);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const sos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_205; i += 1) {
      const h = so();
      sos.push(h);
      lines.push(soLine(h));
    }
    const { status, body } = await getLines(harness({ sos, lines }, 1, 1_000));
    expect(status).toBe(200);
    expect(body.soCount).toBe(1_205);
    expect(body.lineCount).toBe(1_205);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_205);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s orders or lines, and still exports its own', async () => {
    const mine = so({ company_id: 1, doc_no: 'SO-SHARED-NO' });
    const theirs = so({ company_id: 2, doc_no: '2990-SO-000001' });
    /* A company-2 line carrying company 1's doc number: a doc number is not
       company scope (R105 b), so it must not ride along. */
    const planted = soLine(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { sos: [mine, theirs], lines: [soLine(mine), soLine(theirs), planted] };

    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual(['SO-SHARED-NO']);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');

    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['2990-SO-000001']);
  });
});

describe('one row per line, in the contract order', () => {
  it('shapes the cells from the list\'s own rules', async () => {
    const h = so({ doc_no: 'HC-SO-013389', on_hold: true, ref: 'CUST-77', customer_so_no: 'OLD', agent: null, salesperson_id: 'staff-1' });
    const l = soLine(h, { qty: 3, warehouse_id: 'wh-pg', remark: 'call first', unit_price_sen: 123456.5, discount_sen: 1000, total_sen: 369370, line_delivery_date: '2026-10-02' });
    const doLoaded = { id: 'do-1', company_id: 1, do_number: 'HC-DO-000001', so_doc_no: h.doc_no, status: 'LOADED', do_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' };
    const doDraft = { id: 'do-2', company_id: 1, do_number: 'HC-DO-000002', so_doc_no: h.doc_no, status: 'DRAFT', do_date: '2026-09-02', created_at: '2026-09-02T00:00:00Z' };
    const doCancelled = { id: 'do-3', company_id: 1, do_number: 'HC-DO-000003', so_doc_no: h.doc_no, status: 'CANCELLED', do_date: '2026-09-03', created_at: '2026-09-03T00:00:00Z' };
    const doLines = [
      { id: 'dol-1', company_id: 1, delivery_order_id: 'do-1', so_item_id: l.id, item_code: l.item_code, qty: 1, parent: { status: 'LOADED' } },
      { id: 'dol-2', company_id: 1, delivery_order_id: 'do-2', so_item_id: l.id, item_code: l.item_code, qty: 1, parent: { status: 'DRAFT' } },
      { id: 'dol-3', company_id: 1, delivery_order_id: 'do-3', so_item_id: l.id, item_code: l.item_code, qty: 2, parent: { status: 'CANCELLED' } },
    ];
    const poLines = [
      { id: 'pol-1', company_id: 1, so_item_id: l.id, purchase_order_id: 'po-1', delivery_date: '2026-09-20' },
      { id: 'pol-2', company_id: 1, so_item_id: l.id, purchase_order_id: 'po-2', delivery_date: '2026-09-15' },
    ];
    const pos = [
      { id: 'po-1', company_id: 1, po_number: 'HC-PO-009950', status: 'SUBMITTED' },
      { id: 'po-2', company_id: 1, po_number: 'HC-PO-009000', status: 'CANCELLED' },
    ];
    const base = [{ doc_no: h.doc_no, company_id: 1, debtor_code: h.debtor_code, debtor_name: h.debtor_name, linked_ac_docno: 'SO-2609-0042', delivery_address1: '9 JALAN DELIVER', delivery_address2: 'PUCHONG', delivery_address3: null, delivery_address4: null }];
    const staff = [{ id: 'staff-1', name: 'WEI SIANG', staff_code: 'WS' }];
    const app = harness({ sos: [h], lines: [l], dos: [doLoaded, doDraft, doCancelled], doLines, poLines, pos, base, staff });
    const { body } = await getLines(app);
    expect(body.columns).toEqual([...SO_LINE_EXPORT_COLUMNS]);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-SO-013389',
      'AutoCount Doc No': 'SO-2609-0042',
      'Doc Date': '2026-08-10',
      'Status': 'Partially Delivered (On Hold)', // the list pill: 1 of 3 left on a Confirmed DO
      'Customer Code': '300-A001',
      'Customer Name': 'ALICE TAN',
      'Customer Ref': 'CUST-77', // ref leads customer_so_no
      'Item Code': 'ZN-5530-3S',
      'Item Description': 'ZANOTTI 5530 3 SEATER',
      'Item Description 2': 'FABRIC KN-12',
      'Remarks': 'call first',
      'Category': 'sofa',
      'Location': 'PG', // AutoCount's short code
      'UOM': 'UNIT',
      'Qty': 3,
      'Delivered Qty': 1, // the LOADED (Confirmed) DO counts; DRAFT and CANCELLED do not
      'Returned Qty': 0,
      'Remaining Qty': 2,
      'On Delivery Order Qty': 1, // the DRAFT
      'Stock Status': 'PENDING',
      'Unit Price': 1234.565,
      'Discount': 10,
      'Line Total': 3693.7,
      'Doc Balance': 400, // the live balance, not the stored gross
      'Delivery Date': '2026-10-02',
      'Processing Date': null,
      'Salesperson': 'WEI SIANG',
      'Branding': 'ZANOTTI',
      'Venue': 'IOI CITY MALL',
      'Sales Location': 'KL',
      'Phone': '60123456789',
      'Delivery Address': '9 JALAN DELIVER, PUCHONG',
      'State': 'SELANGOR',
      'DO No.': 'HC-DO-000001, HC-DO-000002',
      'PO No.': 'HC-PO-009950',
      'PO Delivery Date': '2026-09-20',
      'Line ID': l.id,
    });
  });

  it('falls back to the header delivery date and address, and keeps a line with no warehouse on its stored code', async () => {
    const h = so({ customer_delivery_date: '2026-09-30' });
    const { body } = await getLines(harness({ sos: [h], lines: [soLine(h, { warehouse_id: null, location: 'SRW' })] }));
    expect(col(body, 'Delivery Date')).toEqual(['2026-09-30']);
    expect(col(body, 'Delivery Address')).toEqual(['1 JALAN A']);
    expect(col(body, 'Location')).toEqual(['SRW']);
    expect(col(body, 'Salesperson')).toEqual(['NICO']);
  });
});
