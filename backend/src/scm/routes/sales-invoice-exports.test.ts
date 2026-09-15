// GET /sales-invoices/export/lines and /export/headers — the Sales Invoices
// list's exports over EVERY page its filters match (owner 2026-09-15).
//
// Harness follows purchase-order-exports.test.ts. WHAT IS ASSERTED:
//   1. The export follows the list's tab, search, date range and sort (the
//      SAME filter the list builds, lib/si-list-read.ts) — and its SALES SCOPE:
//      a seller's file holds only the invoices their list shows.
//   2. It holds every matching invoice, past PostgREST's response ceiling.
//   3. Company scope holds on the header, the line and the DO hops.
//   4. One row per line in the contract order; Balance is net of the order's
//      deposit; the DO and its warehouse come through the DO line.
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { SI_LINE_EXPORT_COLUMNS } from '../lib/si-line-export-columns';
import { buildSiLineExport } from '../lib/si-line-export';
import { siHeaderExportHandler, siLineExportHandler } from './sales-invoice-exports';

type Row = Record<string, unknown>;

let seq = 0;
const si = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `si-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    invoice_number: `HC-SI-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null,
    invoice_date: '2026-09-01',
    status: 'SENT',
    debtor_code: '300-C001',
    debtor_name: 'TAN AH KOW',
    ref: null,
    customer_so_no: null,
    po_doc_no: null,
    due_date: null,
    total_sen: 100000,
    local_total_sen: 100000,
    paid_sen: 0,
    salesperson_id: 'staff-1',
    agent: 'AGENT TEXT',
    branding: 'HOUZS',
    venue: 'IOI CITY MALL',
    phone: '+60123456789',
    so_doc_no: null,
    sales_location: 'KL WAREHOUSE',
    delivery_order_id: null,
    ...over,
  };
};

const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `sii-${String(seq).padStart(5, '0')}`,
    sales_invoice_id: h.id,
    company_id: h.company_id,
    line_no: 1,
    created_at: '2026-09-01T00:00:00Z',
    do_item_id: null,
    item_code: 'CODY-(K)',
    description: 'CODY KING',
    description2: null,
    notes: null,
    item_group: 'mattress',
    uom: 'UNIT',
    qty: 1,
    unit_price_sen: 100000,
    discount_sen: 0,
    line_total_sen: 100000,
    line_delivery_date: null,
    ...over,
  };
};

type Tables = { sis: Row[]; lines: Row[]; doLines?: Row[]; dos?: Row[]; orders?: Row[]; payments?: Row[] };

const tablesFor = (t: Tables) => ({
  sales_invoices: t.sis,
  sales_invoice_items: t.lines,
  delivery_order_items: t.doLines ?? [],
  delivery_orders: t.dos ?? [],
  mfg_sales_orders: t.orders ?? [],
  mfg_sales_order_payments: t.payments ?? [],
  staff: [{ id: 'staff-1', name: 'SITI' }],
  warehouses: [
    { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
    { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
  ],
});

function harness(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb(tablesFor(t), {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    // A view-all caller: the scope resolves to null without a lookup.
    c.set('houzsUser', { id: 7, permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/export/lines', siLineExportHandler);
  app.get('/export/headers', siHeaderExportHandler);
  return app;
}

type LinesBody = { error?: string; columns: string[]; rows: Array<Array<string | number | null>>; siCount: number; lineCount: number; truncated: boolean };

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const colOf = (columns: readonly string[], rows: Array<Array<string | number | null>>, name: (typeof SI_LINE_EXPORT_COLUMNS)[number]) => {
  const i = columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return rows.map((r) => r[i]);
};
const col = (body: LinesBody, name: (typeof SI_LINE_EXPORT_COLUMNS)[number]) => colOf(body.columns, body.rows, name);

const ctx = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });
const NO_FILTER = { status: null, q: null, from: null, to: null, sort: null };

afterEach(() => {
  vi.useRealTimers();
});

describe('the line export follows the list filters', () => {
  it('holds only the tab the list is on (sent = DRAFT + SENT + OVERDUE)', async () => {
    const sent = si({ status: 'SENT', invoice_number: 'A' });
    const overdue = si({ status: 'OVERDUE', invoice_number: 'B' });
    const paid = si({ status: 'PAID', invoice_number: 'C' });
    const app = harness({ sis: [sent, overdue, paid], lines: [line(sent), line(overdue), line(paid)] });
    const { status, body } = await getLines(app, '?status=sent&sort=invoice_number:asc');
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual(['A', 'B']);
    expect(col(body, 'Status')).toEqual(['Submitted', 'Overdue']);
  });

  it('applies the search box to the customer name', async () => {
    const hit = si({ debtor_name: 'LIM MEI LING' });
    const miss = si();
    const { body } = await getLines(harness({ sis: [hit, miss], lines: [line(hit), line(miss)] }), '?q=MEI');
    expect(col(body, 'Doc No')).toEqual([hit.invoice_number]);
  });

  it('applies the invoice date range', async () => {
    const inRange = si({ invoice_date: '2026-09-10' });
    const old = si({ invoice_date: '2026-06-10' });
    const { body } = await getLines(harness({ sis: [inRange, old], lines: [line(inRange), line(old)] }), '?from=2026-09-01&to=2026-09-30');
    expect(col(body, 'Doc No')).toEqual([inRange.invoice_number]);
  });

  it('carries cancelled invoices only when the tab includes them', async () => {
    const live = si();
    const cancelled = si({ status: 'CANCELLED' });
    const tables = { sis: [live, cancelled], lines: [line(live), line(cancelled)] };
    expect(new Set(col((await getLines(harness(tables))).body, 'Status'))).toEqual(new Set(['Submitted', 'Cancelled']));
    expect(col((await getLines(harness(tables), '?status=sent')).body, 'Status')).toEqual(['Submitted']);
  });

  it('holds only the invoices of the sellers the caller may see', async () => {
    const mine = si({ salesperson_id: 'staff-1' });
    const other = si({ salesperson_id: 'staff-9' });
    const sb = fakeSb(tablesFor({ sis: [mine, other], lines: [line(mine), line(other)] }));
    const out = await buildSiLineExport(sb, ctx(1), NO_FILTER, ['staff-1'], '2026-09-15');
    if (out.error !== null) throw new Error(out.error);
    expect(colOf(out.columns, out.rows, 'Doc No')).toEqual([mine.invoice_number]);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const sis: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_003; i += 1) {
      const h = si();
      sis.push(h);
      lines.push(line(h));
    }
    const { status, body } = await getLines(harness({ sis, lines }, 1, 1_000), '?status=sent');
    expect(status).toBe(200);
    expect(body.siCount).toBe(1_003);
    expect(body.lineCount).toBe(1_003);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_003);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s invoices or lines, and still exports its own', async () => {
    const mine = si({ company_id: 1 });
    const theirs = si({ company_id: 2, invoice_number: '2990-SI-THEIRS' });
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { sis: [mine, theirs], lines: [line(mine), line(theirs), planted] };
    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual([mine.invoice_number]);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');
    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['2990-SI-THEIRS']);
  });

  it('does not print another company\'s delivery order through the DO line', async () => {
    const h = si({ sales_location: null });
    const tables = {
      sis: [h],
      lines: [line(h, { do_item_id: 'doi-x' })],
      doLines: [{ id: 'doi-x', company_id: 2, delivery_order_id: 'do-x' }],
      dos: [{ id: 'do-x', company_id: 2, do_number: '2990-DO-1', warehouse_id: 'wh-pg', sales_location: 'PG WAREHOUSE' }],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'DO No.')).toEqual([null]);
    expect(col(body, 'Location')).toEqual([null]);
  });
});

describe('one row per line, in the contract order', () => {
  it('shapes the cells: DO through the DO line, Balance net of the order deposit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T04:00:00Z'));
    const h = si({
      invoice_number: 'HC-SI-2608-004',
      linked_ac_docno: 'IV-2608-004',
      invoice_date: '2026-08-23',
      ref: null,
      customer_so_no: 'CUST-PO-77',
      due_date: '2026-09-10',
      total_sen: 300_000,
      local_total_sen: 300_000,
      paid_sen: 50_000,
      so_doc_no: 'HC-SO-2608-006',
    });
    const l = line(h, {
      do_item_id: 'doi-1',
      qty: 2,
      unit_price_sen: 150000,
      discount_sen: 0,
      line_total_sen: 300000,
      description2: 'FABRIC KN-12',
      notes: 'deliver after 6pm',
      line_delivery_date: '2026-08-25',
    });
    const tables = {
      sis: [h],
      lines: [l],
      doLines: [{ id: 'doi-1', company_id: 1, delivery_order_id: 'do-1' }],
      dos: [{ id: 'do-1', company_id: 1, do_number: 'HC-DO-2608-010', warehouse_id: 'wh-pg', sales_location: 'KL WAREHOUSE' }],
      orders: [{ doc_no: 'HC-SO-2608-006', company_id: 1, total_revenue_sen: 300_000, deposit_sen: 0 }],
      payments: [{ so_doc_no: 'HC-SO-2608-006', amount_sen: 200_000, is_deposit: true }],
    };
    const { status, body } = await getLines(harness(tables));
    expect(status).toBe(200);
    expect(body.columns).toEqual([...SI_LINE_EXPORT_COLUMNS]);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-SI-2608-004',
      'AutoCount Doc No': 'IV-2608-004',
      'Doc Date': '2026-08-23',
      'Status': 'Submitted',
      'Customer Code': '300-C001',
      'Customer Name': 'TAN AH KOW',
      'Customer Ref': 'CUST-PO-77',
      'Item Code': 'CODY-(K)',
      'Item Description': 'CODY KING',
      'Item Description 2': 'FABRIC KN-12',
      'Remarks': 'deliver after 6pm',
      'Category': 'mattress',
      'Location': 'PG', // the delivery order's warehouse, as the book spells it
      'UOM': 'UNIT',
      'Qty': 2,
      'Unit Price': 1500,
      'Discount': 0,
      'Line Total': 3000,
      'Invoice Total': 3000,
      'Paid': 500,
      'Balance': 500, // 3,000 − 500 paid − 2,000 order deposit
      'Delivery Date': '2026-08-25',
      'Due Date': '2026-09-10',
      'Overdue Days': 5,
      'Salesperson': 'SITI',
      'Branding': 'HOUZS',
      'Venue': 'IOI CITY MALL',
      'Phone': '+60123456789',
      'SO Doc No.': 'HC-SO-2608-006',
      'DO No.': 'HC-DO-2608-010',
      'Line ID': l.id,
    });
  });

  it('orders lines by line_no, a blank line_no last', async () => {
    const h = si();
    const tables = {
      sis: [h],
      lines: [
        line(h, { line_no: null, item_code: 'LAST' }),
        line(h, { line_no: 2, item_code: 'SECOND' }),
        line(h, { line_no: 1, item_code: 'FIRST' }),
      ],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'Item Code')).toEqual(['FIRST', 'SECOND', 'LAST']);
  });

  it('falls back to the agent text, and to the invoice sales location with no DO line', async () => {
    const h = si({ salesperson_id: null, agent: 'WALK-IN DESK', sales_location: 'KL WAREHOUSE' });
    const { body } = await getLines(harness({ sis: [h], lines: [line(h)] }));
    expect(col(body, 'Salesperson')).toEqual(['WALK-IN DESK']);
    expect(col(body, 'Location')).toEqual(['KL']);
  });

  it('refuses the file when the order deposit could not be read', async () => {
    const h = si({ so_doc_no: 'HC-SO-1' });
    const sb = fakeSb(tablesFor({ sis: [h], lines: [line(h)] }), { mfg_sales_order_payments: ['is_deposit'] });
    const out = await buildSiLineExport(sb, ctx(1), NO_FILTER, null, '2026-09-15');
    expect(out.error).toMatch(/deposit/);
  });
});

describe('the header export', () => {
  it('returns every matching invoice in the list row shape, deposit stamped', async () => {
    const sis: Row[] = [];
    for (let i = 0; i < 1_002; i += 1) sis.push(si());
    const paid = si({ status: 'PAID' });
    const res = await harness({ sis: [...sis, paid], lines: [] }, 1, 1_000).request('/export/headers?status=sent');
    const body = (await res.json()) as { salesInvoices: Row[]; total: number; truncated: boolean };
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_002);
    expect(body.salesInvoices.map((r) => r.id)).not.toContain(paid.id);
    expect(body.salesInvoices.every((r) => r.so_deposit_applied_sen === 0)).toBe(true);
  });
});
