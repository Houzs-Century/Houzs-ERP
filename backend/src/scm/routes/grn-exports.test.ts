// GET /grns/export/lines and /export/headers — the Goods Received list's
// exports over EVERY page its filters match (owner 2026-09-15).
//
// Harness follows purchase-order-exports.test.ts: a bare Hono app whose
// middleware injects the fake PostgREST client and a company context, mounting
// the EXPORTED handlers.
//
// WHAT IS ASSERTED is the owner's requirement:
//   1. The export follows the list's tab, search and sort — the SAME filter the
//      list builds (lib/grn-list-read.ts).
//   2. It holds every matching receipt, past PostgREST's response ceiling.
//   3. Company scope holds on the header, the line and every lookup read.
//   4. One row per line, in the contract order: the AutoCount number from the
//      right column, Invoiced Qty as the ERP's own invoice lines add up.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { GRN_LINE_EXPORT_COLUMNS } from '../lib/grn-line-export-columns';
import { grnHeaderExportHandler, grnLineExportHandler } from './grn-exports';

type Row = Record<string, unknown>;

let seq = 0;
const grn = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `grn-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    grn_number: `HC-GRN-${String(seq).padStart(6, '0')}`,
    received_at: '2026-09-01',
    status: 'POSTED',
    on_hold: false,
    notes: null,
    delivery_note_ref: 'DN-1',
    currency: 'MYR',
    supplier_id: 'sup-1',
    supplier: { code: '400-D001', name: 'DIGLANT MANUFACTURING SDN BHD.' },
    warehouse_id: 'wh-kl',
    total_sen: 0,
    linked_ac_docno: null,
    linked_ac_gr_docno: null,
    migrated_no_stock: false,
    ...over,
  };
};

const line = (g: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `gi-${String(seq).padStart(5, '0')}`,
    grn_id: g.id,
    company_id: g.company_id,
    created_at: `2026-09-01T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    purchase_order_item_id: null,
    item_code: 'CODY-(K)',
    supplier_sku: 'DG-CODY',
    material_name: 'CODY KING',
    description: null,
    description2: 'FABRIC KN-12',
    notes: null,
    item_group: 'mattress',
    uom: 'UNIT',
    qty_accepted: 4,
    returned_qty: 0,
    invoiced_qty: 0,
    unit_price_sen: 45000,
    discount_sen: 0,
    line_total_sen: 180000,
    delivery_date: null,
    variants: null,
    ...over,
  };
};

type Tables = { grns: Row[]; lines: Row[]; poLines?: Row[]; pos?: Row[]; so?: Row[]; piLines?: Row[]; pis?: Row[] };

function harness(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb({
    grns: t.grns,
    grn_items: t.lines,
    purchase_order_items: t.poLines ?? [],
    purchase_orders: t.pos ?? [],
    mfg_sales_order_items: t.so ?? [],
    purchase_invoice_items: t.piLines ?? [],
    purchase_invoices: t.pis ?? [],
    warehouses: [
      { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
      { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
    ],
  }, {}, [], [], maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    await next();
  });
  app.get('/export/lines', grnLineExportHandler);
  app.get('/export/headers', grnHeaderExportHandler);
  return app;
}

type LinesBody = { error?: string; columns: string[]; rows: Array<Array<string | number | null>>; grnCount: number; lineCount: number; truncated: boolean };

const getLines = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/lines${qs}`);
  return { status: res.status, body: (await res.json()) as LinesBody };
};

const col = (body: LinesBody, name: (typeof GRN_LINE_EXPORT_COLUMNS)[number]) => {
  const i = body.columns.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return body.rows.map((r) => r[i]);
};

describe('the line export follows the list filters', () => {
  it('holds only the tab the list is on (posted = POSTED + CLOSED)', async () => {
    const posted = grn({ status: 'POSTED' });
    const closed = grn({ status: 'CLOSED' });
    const draft = grn({ status: 'DRAFT' });
    const app = harness({ grns: [posted, closed, draft], lines: [line(posted), line(closed), line(draft)] });
    const { status, body } = await getLines(app, '?status=posted&sort=grn_number:asc');
    expect(status).toBe(200);
    expect(col(body, 'Doc No')).toEqual([posted.grn_number, closed.grn_number]);
    expect(col(body, 'Status')).toEqual(['Submitted', 'Closed']);
  });

  it('applies the search box to the GRN number, delivery note and notes', async () => {
    const hit = grn({ grn_number: 'HC-GRN-004411' });
    const dn = grn({ delivery_note_ref: 'DO-004411' });
    const miss = grn();
    const app = harness({ grns: [hit, dn, miss], lines: [line(hit), line(dn), line(miss)] });
    const { body } = await getLines(app, '?q=004411');
    expect(new Set(col(body, 'Doc No'))).toEqual(new Set([hit.grn_number, dn.grn_number]));
  });

  it('reads the on-hold MARKER for the On Hold tab, and says so after the status word', async () => {
    const held = grn({ on_hold: true });
    const live = grn();
    const app = harness({ grns: [held, live], lines: [line(held), line(live)] });
    const { body } = await getLines(app, '?status=on_hold');
    expect(col(body, 'Doc No')).toEqual([held.grn_number]);
    expect(col(body, 'Status')).toEqual(['Submitted (On Hold)']);
  });

  it('applies the received date range', async () => {
    const early = grn({ received_at: '2026-08-01' });
    const late = grn({ received_at: '2026-09-10' });
    const app = harness({ grns: [early, late], lines: [line(early), line(late)] });
    const { body } = await getLines(app, '?from=2026-09-01&to=2026-09-30');
    expect(col(body, 'Doc No')).toEqual([late.grn_number]);
  });

  it('carries cancelled receipts only when the tab includes them', async () => {
    const live = grn();
    const cancelled = grn({ status: 'CANCELLED' });
    const tables = { grns: [live, cancelled], lines: [line(live), line(cancelled)] };
    expect(new Set(col((await getLines(harness(tables))).body, 'Status'))).toEqual(new Set(['Submitted', 'Cancelled']));
    expect(col((await getLines(harness(tables), '?status=posted')).body, 'Status')).toEqual(['Submitted']);
  });
});

describe('the line export holds every page, not the screen page', () => {
  it('returns every line past the PostgREST response ceiling', async () => {
    const grns: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) {
      const g = grn();
      grns.push(g);
      lines.push(line(g));
    }
    const app = harness({ grns, lines }, 1, 1_000);
    const { status, body } = await getLines(app, '?status=posted');
    expect(status).toBe(200);
    expect(body.grnCount).toBe(1_105);
    expect(body.lineCount).toBe(1_105);
    expect(new Set(col(body, 'Line ID')).size).toBe(1_105);
    expect(body.truncated).toBe(false);
  });
});

describe('company scope', () => {
  it('never exports another company\'s receipts or lines, and still exports its own', async () => {
    const mine = grn({ company_id: 1 });
    const theirs = grn({ company_id: 2, grn_number: '2990-GRN-THEIRS' });
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const tables = { grns: [mine, theirs], lines: [line(mine), line(theirs), planted] };

    const one = await getLines(harness(tables, 1));
    expect(col(one.body, 'Doc No')).toEqual([mine.grn_number]);
    expect(col(one.body, 'Item Code')).not.toContain('PLANTED');

    const two = await getLines(harness(tables, 2));
    expect(col(two.body, 'Doc No')).toEqual(['2990-GRN-THEIRS']);
  });

  it('does not count another company\'s invoice lines or print their numbers', async () => {
    const g = grn();
    const l = line(g, { qty_accepted: 5 });
    const tables = {
      grns: [g],
      lines: [l],
      piLines: [
        { id: 'pii-1', company_id: 1, purchase_invoice_id: 'pi-1', grn_item_id: l.id, qty: 2 },
        { id: 'pii-2', company_id: 2, purchase_invoice_id: 'pi-2', grn_item_id: l.id, qty: 3 },
      ],
      pis: [
        { id: 'pi-1', company_id: 1, invoice_number: 'HC-PI-000001', status: 'POSTED' },
        { id: 'pi-2', company_id: 2, invoice_number: '2990-PI-000001', status: 'POSTED' },
      ],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'Invoiced Qty')).toEqual([2]);
    expect(col(body, 'Invoice No.')).toEqual(['HC-PI-000001']);
  });
});

describe('one row per line, in the contract order', () => {
  it('shapes the cells: links through the PO line, Location as the short code', async () => {
    const g = grn({ grn_number: 'HC-GRN-000610', linked_ac_docno: 'GR-2609-004', warehouse_id: 'wh-pg', delivery_note_ref: 'DN-7788' });
    const l = line(g, {
      purchase_order_item_id: 'poi-1',
      qty_accepted: 5,
      returned_qty: 1,
      unit_price_sen: 5.5,
      discount_sen: 100,
      line_total_sen: 2650,
      notes: 'two boxes dented',
      delivery_date: '2026-09-20',
    });
    const tables = {
      grns: [g],
      lines: [l],
      poLines: [{ id: 'poi-1', company_id: 1, purchase_order_id: 'po-1', so_item_id: 'soi-1' }],
      pos: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-009951' }],
      so: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389' }],
      piLines: [
        { id: 'pii-1', company_id: 1, purchase_invoice_id: 'pi-1', grn_item_id: l.id, qty: 2 },
        { id: 'pii-2', company_id: 1, purchase_invoice_id: 'pi-draft', grn_item_id: l.id, qty: 1 },
        { id: 'pii-3', company_id: 1, purchase_invoice_id: 'pi-x', grn_item_id: l.id, qty: 1 },
      ],
      pis: [
        { id: 'pi-1', company_id: 1, invoice_number: 'HC-PI-000001', status: 'POSTED' },
        { id: 'pi-draft', company_id: 1, invoice_number: 'HC-PI-000002', status: 'DRAFT' },
        { id: 'pi-x', company_id: 1, invoice_number: 'HC-PI-000003', status: 'CANCELLED' },
      ],
    };
    const { body } = await getLines(harness(tables));
    expect(body.columns).toEqual([...GRN_LINE_EXPORT_COLUMNS]);
    const row = Object.fromEntries(body.columns.map((c, i) => [c, body.rows[0]![i]]));
    expect(row).toEqual({
      'Doc No': 'HC-GRN-000610',
      'AutoCount Doc No': 'GR-2609-004',
      'Doc Date': '2026-09-01',
      'Status': 'Submitted',
      'Supplier Code': '400-D001',
      'Supplier Name': 'DIGLANT MANUFACTURING SDN BHD.',
      'Supplier DO No.': 'DN-7788',
      'Item Code': 'CODY-(K)',
      'Supplier SKU': 'DG-CODY',
      'Item Description': 'CODY KING',
      'Item Description 2': 'FABRIC KN-12',
      'Remarks': 'two boxes dented',
      'Category': 'mattress',
      'Location': 'PG',
      'UOM': 'UNIT',
      'Received Qty': 5,
      'Invoiced Qty': 2, // the draft and the cancelled invoice bill nothing
      'Returned Qty': 1,
      'Uninvoiced Qty': 2,
      'Currency': 'MYR',
      'Unit Price': 0.055,
      'Discount': 1,
      'Line Total': 26.5,
      'Delivery Date': '2026-09-20',
      'PO No.': 'HC-PO-009951',
      'SO Doc No.': 'HC-SO-013389',
      'Invoice No.': 'HC-PI-000001',
      'Line ID': l.id,
    });
  });

  it('reads Invoiced Qty from the invoice lines, never the stored migrated figure', async () => {
    const g = grn({ migrated_no_stock: true });
    const l = line(g, { qty_accepted: 6, invoiced_qty: 6 });
    const { body } = await getLines(harness({ grns: [g], lines: [l] }));
    expect(col(body, 'Invoiced Qty')).toEqual([0]);
    expect(col(body, 'Uninvoiced Qty')).toEqual([6]);
  });

  it('takes the AutoCount GR number from the column that holds it', async () => {
    const migrated = grn({ grn_number: 'A', migrated_no_stock: true, linked_ac_docno: 'PO-2608-001', linked_ac_gr_docno: 'GR-2608-010' });
    const migratedNoGr = grn({ grn_number: 'B', migrated_no_stock: true, linked_ac_docno: 'PO-2608-002', linked_ac_gr_docno: null });
    const created = grn({ grn_number: 'C', migrated_no_stock: false, linked_ac_docno: 'HC-GRN-000100' });
    const tables = { grns: [migrated, migratedNoGr, created], lines: [line(migrated), line(migratedNoGr), line(created)] };
    const { body } = await getLines(harness(tables), '?sort=grn_number:asc');
    expect(col(body, 'AutoCount Doc No')).toEqual(['GR-2608-010', null, 'HC-GRN-000100']);
  });

  it('does not print another company\'s PO number on a line', async () => {
    const g = grn();
    const tables = {
      grns: [g],
      lines: [line(g, { purchase_order_item_id: 'poi-2' })],
      poLines: [{ id: 'poi-2', company_id: 2, purchase_order_id: 'po-2', so_item_id: null }],
      pos: [{ id: 'po-2', company_id: 2, po_number: '2990-PO-000001' }],
    };
    const { body } = await getLines(harness(tables));
    expect(col(body, 'PO No.')).toEqual([null]);
  });
});

describe('the header export', () => {
  it('returns every matching receipt in the list row shape', async () => {
    const grns: Row[] = [];
    for (let i = 0; i < 1_020; i += 1) grns.push(grn());
    const cancelled = grn({ status: 'CANCELLED' });
    const app = harness({ grns: [...grns, cancelled], lines: [] }, 1, 1_000);
    const res = await app.request('/export/headers?status=posted');
    const body = (await res.json()) as { grns: Row[]; total: number; truncated: boolean };
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_020);
    expect(body.grns.map((r) => r.id)).not.toContain(cancelled.id);
    expect(body.truncated).toBe(false);
  });
});
