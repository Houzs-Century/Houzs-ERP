// GET /purchase-invoices/export/lines and /export/headers — the Purchase
// Invoices list's exports over EVERY page its filters match (owner 2026-09-15).
//
// Harness follows purchase-order-exports.test.ts. WHAT IS ASSERTED:
//   1. The export follows the list's tab, search, date range and sort (the
//      SAME filter the list builds, lib/pi-list-read.ts).
//   2. It holds every matching invoice, past PostgREST's response ceiling.
//   3. Company scope holds on the header, the line and every hop to the GRN,
//      PO and SO.
//   4. One row per line in the contract order; the due date is the STORED one.
import { Hono } from 'hono';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { PI_LINE_EXPORT_COLUMNS, overdueDays } from '../lib/pi-line-export-columns';
import { piHeaderExportHandler, piLineExportHandler } from './purchase-invoice-exports';

type Row = Record<string, unknown>;

let seq = 0;
const pi = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pi-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    invoice_number: `HC-PI-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null,
    invoice_date: '2026-09-01',
    status: 'POSTED',
    on_hold: false,
    notes: null,
    supplier_invoice_ref: 'INV-1',
    currency: 'MYR',
    due_date: null,
    total_sen: 100000,
    paid_sen: 0,
    supplier: { code: '400-D001', name: 'DIGLANT MANUFACTURING SDN BHD.' },
    ...over,
  };
};

const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pii-${String(seq).padStart(5, '0')}`,
    purchase_invoice_id: h.id,
    company_id: h.company_id,
    created_at: `2026-09-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    grn_item_id: null,
    item_code: 'CODY-(K)',
    material_name: 'CODY KING',
    description: null,
    description2: null,
    notes: null,
    item_group: 'mattress',
    uom: 'UNIT',
    qty: 2,
    po_unit_price_sen: 50000,
    unit_price_sen: 50000,
    discount_sen: 0,
    line_total_sen: 100000,
    variants: null,
    ...over,
  };
};

type Tables = { pis: Row[]; lines: Row[]; grnLines?: Row[]; grns?: Row[]; poLines?: Row[]; pos?: Row[]; so?: Row[] };

function harness(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    purchase_invoices: t.pis,
    purchase_invoice_items: t.lines,
    grn_items: t.grnLines ?? [],
    grns: t.grns ?? [],
    purchase_order_items: t.poLines ?? [],
    purchase_orders: t.pos ?? [],
    mfg_sales_order_items: t.so ?? [],
    warehouses: [{ id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' }],
  }, {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    await next();
  });
  app.get('/export/lines', piLineExportHandler);
  app.get('/export/headers', piHeaderExportHandler);
  return app;
}

type LinesBody = { error?: string; columns: string[]; rows: Array<Array<string | number | null>>; piCount: number; lineCount: number; truncated: boolean };

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const col = (body: LinesBody, name: (typeof PI_LINE_EXPORT_COLUMNS)[number]) => {
  const i = body.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return body.rows.map((r) => r[i]);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('the line export follows the list filters', () => {
  it('holds only the tab the list is on', async () => {
    const posted = pi({ status: 'POSTED' });
    const paid = pi({ status: 'PAID' });
    const app = harness({ pis: [posted, paid], lines: [line(posted), line(paid)] });
    const { status, body } = await getLines(app, '?status=paid');
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual([paid.invoice_number]);
    expect(col(body, 'Status')).toEqual(['Paid']);
  });

  it('applies the search box to the invoice number, supplier invoice and notes', async () => {
    const hit = pi({ invoice_number: 'HC-PI-007788' });
    const ref = pi({ supplier_invoice_ref: 'SUP-007788' });
    const miss = pi();
    const app = harness({ pis: [hit, ref, miss], lines: [line(hit), line(ref), line(miss)] });
    const { body } = await getLines(app, '?q=007788');
    expect(new Set(col(body, 'Doc No'))).toEqual(new Set([hit.invoice_number, ref.invoice_number]));
  });

  it('reads the on-hold MARKER for the On Hold tab', async () => {
    const held = pi({ on_hold: true, status: 'POSTED' });
    const live = pi();
    const { body } = await getLines(harness({ pis: [held, live], lines: [line(held), line(live)] }), '?status=on_hold');
    expect(col(body, 'Doc No')).toEqual([held.invoice_number]);
    expect(col(body, 'Status')).toEqual(['Submitted (On Hold)']);
  });

  it('applies the invoice date range and the sort', async () => {
    const a = pi({ invoice_number: 'HC-PI-A', invoice_date: '2026-09-02' });
    const b = pi({ invoice_number: 'HC-PI-B', invoice_date: '2026-09-03' });
    const old = pi({ invoice_date: '2026-07-01' });
    const app = harness({ pis: [b, old, a], lines: [line(b), line(old), line(a)] });
    const { body } = await getLines(app, '?from=2026-09-01&to=2026-09-30&sort=invoice_number:asc');
    expect(col(body, 'Doc No')).toEqual(['HC-PI-A', 'HC-PI-B']);
  });

  it('carries cancelled invoices only when the tab includes them', async () => {
    const live = pi();
    const cancelled = pi({ status: 'CANCELLED' });
    const tables = { pis: [live, cancelled], lines: [line(live), line(cancelled)] };
    expect(new Set(col((await getLines(harness(tables))).body, 'Status'))).toEqual(new Set(['Submitted', 'Cancelled']));
    expect(col((await getLines(harness(tables), '?status=posted')).body, 'Status')).toEqual(['Submitted']);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const pis: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_010; i += 1) {
      const h = pi();
      pis.push(h);
      lines.push(line(h));
    }
    const { status, body } = await getLines(harness({ pis, lines }, 1, 1_000), '?status=posted');
    expect(status).toBe(200);
    expect(body.piCount).toBe(1_010);
    expect(body.lineCount).toBe(1_010);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_010);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s invoices or lines, and still exports its own', async () => {
    const mine = pi({ company_id: 1 });
    const theirs = pi({ company_id: 2, invoice_number: '2990-PI-THEIRS' });
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { pis: [mine, theirs], lines: [line(mine), line(theirs), planted] };
    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual([mine.invoice_number]);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');
    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['2990-PI-THEIRS']);
  });

  it('does not print another company\'s GRN, PO or SO through the line\'s links', async () => {
    const h = pi();
    const tables = {
      pis: [h],
      lines: [line(h, { grn_item_id: 'gi-x' })],
      grnLines: [{ id: 'gi-x', company_id: 2, grn_id: 'grn-x', supplier_sku: 'THEIR-SKU', purchase_order_item_id: 'poi-x' }],
      grns: [{ id: 'grn-x', company_id: 2, grn_number: '2990-GRN-1', warehouse_id: 'wh-kl' }],
      poLines: [{ id: 'poi-x', company_id: 2, purchase_order_id: 'po-x', so_item_id: null }],
      pos: [{ id: 'po-x', company_id: 2, po_number: '2990-PO-1' }],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'GRN No.')).toEqual([null]);
    expect(col(body, 'Supplier SKU')).toEqual([null]);
    expect(col(body, 'PO No.')).toEqual([null]);
    expect(col(body, 'Location')).toEqual([null]);
  });
});

describe('one row per line, in the contract order', () => {
  it('shapes the cells through the GRN line, with Balance and Overdue Days from the stored due date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T04:00:00Z')); // 12:00 in Malaysia
    const h = pi({
      invoice_number: 'HC-PI-000252',
      linked_ac_docno: 'PI-2609-003',
      supplier_invoice_ref: 'DG-INV-889',
      due_date: '2026-09-05',
      total_sen: 150000,
      paid_sen: 50000,
      currency: 'MYR',
    });
    const l = line(h, {
      grn_item_id: 'gi-1',
      qty: 3,
      po_unit_price_sen: 50000,
      unit_price_sen: 49000.5,
      discount_sen: 150,
      line_total_sen: 146852,
      description2: 'FABRIC KN-12',
      notes: 'price agreed by phone',
    });
    const tables = {
      pis: [h],
      lines: [l],
      grnLines: [{ id: 'gi-1', company_id: 1, grn_id: 'grn-1', supplier_sku: 'DG-CODY', purchase_order_item_id: 'poi-1' }],
      grns: [{ id: 'grn-1', company_id: 1, grn_number: 'HC-GRN-000610', warehouse_id: 'wh-kl' }],
      poLines: [{ id: 'poi-1', company_id: 1, purchase_order_id: 'po-1', so_item_id: 'soi-1' }],
      pos: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-009951' }],
      so: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' }],
    };
    const { body } = await getLines(harness(tables));
    expect(body.columns).toEqual([...PI_LINE_EXPORT_COLUMNS]);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-PI-000252',
      'AutoCount Doc No': 'PI-2609-003',
      'Doc Date': '2026-09-01',
      'Status': 'Submitted',
      'Supplier Code': '400-D001',
      'Supplier Name': 'DIGLANT MANUFACTURING SDN BHD.',
      'Supplier Invoice No.': 'DG-INV-889',
      'Item Code': 'CODY-(K)',
      'Supplier SKU': 'DG-CODY',
      'Item Description': 'CODY KING',
      'Item Description 2': 'FABRIC KN-12',
      'Remarks': 'price agreed by phone',
      'Category': 'mattress',
      'Location': 'KL',
      'UOM': 'UNIT',
      'Qty': 3,
      'Currency': 'MYR',
      'PO Unit Price': 500,
      'Unit Price': 490.005,
      'Discount': 1.5,
      'Line Total': 1468.52,
      'Invoice Total': 1500,
      'Balance': 1000,
      'Due Date': '2026-09-05',
      'Overdue Days': 10,
      'GRN No.': 'HC-GRN-000610',
      'PO No.': 'HC-PO-009951',
      'SO Doc No.': 'HC-SO-013389',
      'Line ID': l.id,
    });
  });

  it('leaves the due date and overdue days blank when none is stored', async () => {
    const h = pi({ due_date: null, total_sen: 1000, paid_sen: 0 });
    const { body } = await getLines(harness({ pis: [h], lines: [line(h)] }));
    expect(col(body, 'Due Date')).toEqual([null]);
    expect(col(body, 'Overdue Days')).toEqual([null]);
  });
});

describe('overdueDays', () => {
  it('counts only while something is owed, and never below zero', () => {
    expect(overdueDays('2026-09-01', '2026-09-15', 100)).toBe(14);
    expect(overdueDays('2026-09-20', '2026-09-15', 100)).toBe(0);
    expect(overdueDays('2026-09-01', '2026-09-15', 0)).toBeNull();
    expect(overdueDays(null, '2026-09-15', 100)).toBeNull();
  });
});

describe('the header export', () => {
  it('returns every matching invoice in the list row shape', async () => {
    const pis: Row[] = [];
    for (let i = 0; i < 1_005; i += 1) pis.push(pi());
    const paid = pi({ status: 'PAID' });
    const res = await harness({ pis: [...pis, paid], lines: [] }, 1, 1_000).request('/export/headers?status=posted');
    const body = (await res.json()) as { purchaseInvoices: Row[]; total: number; truncated: boolean };
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_005);
    expect(body.purchaseInvoices.map((r) => r.id)).not.toContain(paid.id);
  });
});
