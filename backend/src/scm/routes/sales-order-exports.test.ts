// GET /mfg-sales-orders/export/rows and the line attach it shares with the list
// page (owner 2026-09-15: ONE Export, one row per line, the grid's columns,
// values as AutoCount holds them).
//
// What is asserted:
//   1. The export follows the list's tab, search AND second-level filter rows,
//      past the response ceiling, under the company scope.
//   2. Every order carries `lines` in printed order, with the app's own
//      delivered / returned / remaining reading, AutoCount's short location, the
//      book's item spelling for an order that is in AutoCount (and the ERP's own
//      for one that is not), and Item Description 2 from the variants.
//   3. The list page attaches lines through the same function (a source pin).
//
// buildSoListRows (the list handler's per-row builder, lib/so-list-rows.ts) is
// replaced here: it is the list's verbatim code with its own tests, and its
// reads (the lock switch, MRP inputs) are not what this file is about.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../env';
import { soRouterSource } from '../../../tests/lib/so-router-source';

vi.mock('../lib/so-list-rows', () => ({
  buildSoListRows: vi.fn(async (_sb: unknown, _c: unknown, rows: Array<Record<string, unknown>>) => {
    for (const r of rows) r.list_row_built = true;
    return null;
  }),
}));

import { fakeSb } from '../lib/fake-postgrest';
import { attachSoLines } from '../lib/so-list-lines';
import { acBookItemIndex } from '../../services/autocount-book-item';
import { AC_ITEM_MAP_TSV } from '../../services/autocount-item-map';
import { soExportRowsHandler } from './sales-order-exports';
const routeSource = soRouterSource();

type Row = Record<string, unknown>;

let seq = 0;
const so = (over: Row = {}): Row => {
  seq += 1;
  return {
    doc_no: `HC-SO-${String(seq).padStart(6, '0')}`, company_id: 1, so_date: '2026-08-10', status: 'CONFIRMED',
    on_hold: false, debtor_code: null, debtor_name: 'ALICE TAN', ref: null, customer_so_no: null, branding: 'ZANOTTI',
    venue: 'MID VALLEY', sales_location: 'KL', phone: '60123456789', customer_delivery_date: '2026-09-30',
    salesperson_id: null, agent: 'NICO', ...over,
  };
};
const soLine = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `soi-${String(seq).padStart(5, '0')}`, doc_no: h.doc_no, company_id: h.company_id, line_no: 1,
    created_at: '2026-08-10T00:00:00Z', item_code: 'MISC-ITEM', description: 'OUR WORDS', description2: null,
    variants: null, remark: null, item_group: 'accessory', uom: 'UNIT', location: 'KL', warehouse_id: null, qty: 1,
    stock_status: 'PENDING', unit_price_sen: 1000, discount_sen: 0, total_sen: 1000, line_delivery_date: null,
    cancelled: false, ...over,
  };
};

type Tables = { sos: Row[]; lines: Row[]; base?: Row[]; doLines?: Row[]; dos?: Row[] };

function sbFor(t: Tables, maxRows: number | null = null) {
  return fakeSb({
    mfg_sales_orders_with_payment_totals: t.sos,
    mfg_sales_orders: t.base ?? t.sos.map((h) => ({ doc_no: h.doc_no, company_id: h.company_id, debtor_code: h.debtor_code, debtor_name: h.debtor_name, linked_ac_docno: `SO-${String(h.doc_no).slice(-6)}` })),
    mfg_sales_order_items: t.lines,
    mfg_sales_order_payments: [],
    delivery_orders: t.dos ?? [],
    delivery_order_items: t.doLines ?? [],
    delivery_return_items: [],
    delivery_returns: [],
    purchase_order_items: [],
    purchase_orders: [],
    supplier_material_bindings: [],
    warehouses: [{ id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' }],
    staff: [],
  }, {}, [], [], maxRows);
}

function harness(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = sbFor(t, maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    c.set('houzsUser', { id: 7, permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
    await next();
  });
  app.get('/export/rows', soExportRowsHandler);
  return app;
}

type Body = { salesOrders: Array<Row & { lines: Array<Row> }>; total: number; lineCount: number; next: number | null };
const get = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('the export follows the list filters, every page, one company', () => {
  it('holds the tab AND the second-level filter row', async () => {
    const aug = so({ so_date: '2026-08-10' });
    const sep = so({ so_date: '2026-09-10' });
    const delivered = so({ so_date: '2026-08-11', status: 'DELIVERED' });
    const app = harness({ sos: [aug, sep, delivered], lines: [soLine(aug), soLine(sep), soLine(delivered)] });
    const { status, body } = await get(app, `?status=CONFIRMED&f=${encodeURIComponent('orderDate:between:2026-08-01~2026-08-31')}`);
    expect(status).toBe(200);
    expect(body.salesOrders.map((r) => r.doc_no)).toEqual([aug.doc_no]);
    expect(body.salesOrders[0]!.list_row_built).toBe(true);
    expect(body.salesOrders[0]!.lines).toHaveLength(1);
  });

  it('refuses a filter row the list would refuse', async () => {
    const h = so();
    expect((await get(harness({ sos: [h], lines: [soLine(h)] }), '?f=nonsense:is:x')).status).toBe(400);
  });

  it('serves every order and line in windows of at most 500, past the PostgREST response ceiling, none twice', async () => {
    const sos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) { const h = so(); sos.push(h); lines.push(soLine(h)); }
    const app = harness({ sos, lines }, 1, 1_000);
    const seen: string[] = [];
    const nexts: Array<number | null> = [];
    let lineCount = 0;
    for (let offset: number | null = 0, guard = 0; offset !== null && guard < 10; guard += 1) {
      const { status, body } = await get(app, `?sort=doc_no:asc&offset=${offset}&limit=9999`);
      expect(status).toBe(200);
      expect(body.total).toBeLessThanOrEqual(500);
      seen.push(...body.salesOrders.map((r) => String(r.doc_no)));
      lineCount += body.lineCount;
      nexts.push(body.next);
      offset = body.next;
    }
    expect(nexts).toEqual([500, 1_000, null]);
    expect(new Set(seen).size).toBe(1_105);
    expect(lineCount).toBe(1_105);
  });

  it('never exports another company\'s orders or lines', async () => {
    const mine = so({ doc_no: 'SO-SHARED-NO' });
    const theirs = so({ company_id: 2, doc_no: '2990-SO-000001' });
    const planted = soLine(mine, { company_id: 2, item_code: 'PLANTED' });
    const t = { sos: [mine, theirs], lines: [soLine(mine), soLine(theirs), planted] };
    const one = await get(harness(t, 1));
    expect(one.body.salesOrders.map((r) => r.doc_no)).toEqual(['SO-SHARED-NO']);
    expect(one.body.salesOrders[0]!.lines.map((l) => l.erp_item_code)).not.toContain('PLANTED');
    const two = await get(harness(t, 2));
    expect(two.body.salesOrders.map((r) => r.doc_no)).toEqual(['2990-SO-000001']);
  });
});

describe('attachSoLines — one line shape for the screen and the file', () => {
  const ctx = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });

  it('spells an AutoCount order\'s item as the book does; a 2990 order keeps its own', async () => {
    const [acCode, erpCode] = AC_ITEM_MAP_TSV.split('\n').find((l) => l.startsWith('AERO-Y04 (K)\t'))!.split('\t');
    const book = acBookItemIndex().get(acCode!.toUpperCase())!;
    const inBook = so({ agent: null, venue: 'MID VALLEY', debtor_code: null });
    const notInBook = so({ company_id: 1, doc_no: '2990-SO-000009', debtor_code: '300-X' });
    const t = {
      sos: [inBook, notInBook],
      lines: [soLine(inBook, { item_code: erpCode, item_group: 'bedframe', uom: 'unit', warehouse_id: 'wh-pg' }), soLine(notInBook, { item_code: erpCode, item_group: 'bedframe' })],
      base: [
        { doc_no: inBook.doc_no, company_id: 1, debtor_code: null, debtor_name: 'ALICE TAN', linked_ac_docno: 'SO-013389' },
        { doc_no: notInBook.doc_no, company_id: 1, debtor_code: '300-X', debtor_name: 'ALICE TAN', linked_ac_docno: null },
      ],
    };
    const rows = [{ ...inBook }, { ...notInBook }] as Array<Row & { lines?: Row[] }>;
    const out = await attachSoLines(sbFor(t), ctx(1), rows, null);
    expect(out.error).toBeNull();
    expect(rows[0]).toMatchObject({ ac_doc_no: 'SO-013389', ac_debtor_code: '300-C002' });
    expect(rows[0]!.lines![0]).toMatchObject({ item_code: acCode, erp_item_code: erpCode, item_group: book.itemGroup, uom: book.baseUom, description: book.description, location: 'PG' });
    expect(rows[1]).toMatchObject({ ac_doc_no: '2990-SO-000009', ac_debtor_code: '300-X' });
    expect(rows[1]!.lines![0]).toMatchObject({ item_code: erpCode, item_group: 'bedframe', description: 'OUR WORDS' });
  });

  it('carries the app\'s delivered / remaining reading, what sits on an unshipped DO, and DO numbers', async () => {
    const h = so();
    const l = soLine(h, { qty: 3 });
    const t = {
      sos: [h], lines: [l],
      dos: [
        { id: 'do-1', company_id: 1, do_number: 'HC-DO-1', so_doc_no: h.doc_no, status: 'LOADED', do_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' },
        { id: 'do-2', company_id: 1, do_number: 'HC-DO-2', so_doc_no: h.doc_no, status: 'DRAFT', do_date: '2026-09-02', created_at: '2026-09-02T00:00:00Z' },
        { id: 'do-3', company_id: 1, do_number: 'HC-DO-3', so_doc_no: h.doc_no, status: 'CANCELLED', do_date: '2026-09-03', created_at: '2026-09-03T00:00:00Z' },
      ],
      doLines: [
        { id: 'dol-1', company_id: 1, delivery_order_id: 'do-1', so_item_id: l.id, item_code: l.item_code, qty: 1, parent: { status: 'LOADED' } },
        { id: 'dol-2', company_id: 1, delivery_order_id: 'do-2', so_item_id: l.id, item_code: l.item_code, qty: 1, parent: { status: 'DRAFT' } },
        { id: 'dol-3', company_id: 1, delivery_order_id: 'do-3', so_item_id: l.id, item_code: l.item_code, qty: 2, parent: { status: 'CANCELLED' } },
      ],
    };
    const rows = [{ ...h }] as Array<Row & { lines?: Row[] }>;
    expect((await attachSoLines(sbFor(t), ctx(1), rows, null)).error).toBeNull();
    expect(rows[0]!.lines![0]).toMatchObject({ qty: 3, delivered_qty: 1, returned_qty: 0, remaining_qty: 2, on_delivery_order_qty: 1, do_nos: ['HC-DO-1', 'HC-DO-2'] });
  });

  it('Detail Description 2 is the variant summary, the stored text only where variants compose nothing; delivery date falls back to the header', async () => {
    const h = so({ customer_delivery_date: '2026-10-01' });
    const withVariants = soLine(h, { line_no: 1, item_group: 'bedframe', variants: { fabricCode: 'PC151-01' }, description2: 'STALE TEXT' });
    const plain = soLine(h, { line_no: 2, description2: 'TYPED TEXT', line_delivery_date: '2026-09-20' });
    const rows = [{ ...h }] as Array<Row & { lines?: Row[] }>;
    expect((await attachSoLines(sbFor({ sos: [h], lines: [plain, withVariants] }), ctx(1), rows, null)).error).toBeNull();
    const [first, second] = rows[0]!.lines!;
    expect(first!.id).toBe(withVariants.id);
    expect(String(first!.description2)).toContain('PC151-01');
    expect(first!.description2).not.toBe('STALE TEXT');
    expect(first!.delivery_date).toBe('2026-10-01');
    expect(second).toMatchObject({ description2: 'TYPED TEXT', delivery_date: '2026-09-20' });
  });
});

describe('the list page reads lines through the same attach', () => {
  it('GET / attaches lines with attachSoLines, reusing the builder\'s delivered reading', () => {
    expect(routeSource).toContain('const deliverable = await buildSoListRows(sb, c, rows);');
    expect(routeSource).toContain('const withLines = await attachSoLines(sb, c, rows, deliverable);');
  });
});
