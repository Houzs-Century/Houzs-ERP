// GET /delivery-orders-mfg/export/rows and the line attach it shares with the
// list page (owner 2026-09-15: ONE Export, one row per line, NO prices, values as
// AutoCount holds them).
//
// buildDoListRows (the list handler's verbatim per-row builder,
// lib/do-list-rows.ts) is replaced: its reads are the list's, not this file's.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env, Variables } from '../env';
import routeSource from './delivery-orders-mfg.ts?raw';

vi.mock('../lib/do-list-rows', () => ({
  buildDoListRows: vi.fn(async (_sb: unknown, _c: unknown, rows: Array<Record<string, unknown>>) =>
    rows.map((r) => ({ ...r, list_row_built: true }))),
}));

import { fakeSb } from '../lib/fake-postgrest';
import { attachDoLines } from '../lib/do-list-lines';
import { acBookItemIndex } from '../../services/autocount-book-item';
import { AC_ITEM_MAP_TSV } from '../../services/autocount-item-map';
import { doExportRowsHandler } from './delivery-order-exports';

type Row = Record<string, unknown>;

let seq = 0;
const dOrder = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `do-${String(seq).padStart(5, '0')}`, company_id: 1, do_number: `HC-DO-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: `DO-${String(seq).padStart(6, '0')}`, do_date: '2026-09-01', status: 'DELIVERED', on_hold: false,
    debtor_code: null, debtor_name: 'ALICE TAN', ref: null, so_doc_no: 'HC-SO-013389', customer_delivery_date: '2026-09-05',
    driver_name: null, vehicle: null, warehouse_id: null, sales_location: 'KL', salesperson_id: null, agent: 'NICO', ...over,
  };
};
const doLine = (d: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `dol-${String(seq).padStart(5, '0')}`, delivery_order_id: d.id, company_id: d.company_id, line_no: 1,
    created_at: '2026-09-01T00:00:00Z', item_code: 'MISC-ITEM', description: 'OUR WORDS', description2: null, variants: null,
    notes: null, item_group: 'accessory', uom: 'UNIT', qty: 2, m3_milli: 1850, line_delivery_date: null, so_item_id: null,
    unit_price_sen: 250000, line_total_sen: 500000, ...over,
  };
};

type Tables = { dos: Row[]; lines: Row[]; siLines?: Row[]; sis?: Row[] };
function sbFor(t: Tables, maxRows: number | null = null) {
  return fakeSb({
    delivery_orders: t.dos, delivery_order_items: t.lines, sales_invoice_items: t.siLines ?? [], sales_invoices: t.sis ?? [],
    delivery_return_items: [], delivery_returns: [], mfg_sales_order_items: [], purchase_order_items: [], purchase_orders: [],
    supplier_material_bindings: [], warehouses: [{ id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' }], staff: [],
  }, {}, [], [], maxRows);
}
function harness(t: Tables, companyId = 1, maxRows: number | null = null, houzsUser: unknown = { id: 7, permissions_set: new Set(['*']) }) {
  const sb = sbFor(t, maxRows);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    if (houzsUser) c.set('houzsUser', houzsUser as Variables['houzsUser']);
    await next();
  });
  app.get('/export/rows', doExportRowsHandler);
  return app;
}
type Body = { deliveryOrders: Array<Row & { lines: Row[] }>; total: number; lineCount: number; next: number | null };
const get = async (app: Hono<{ Bindings: Env; Variables: Variables }>, qs = '') => {
  const res = await app.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};
const ctx = (companyId: number) => ({ get: (k: string) => (k === 'companyId' ? companyId : undefined) });

describe('the export follows the list filters, every page, one company', () => {
  it('holds the tab (delivered = SIGNED + DELIVERED) and the search', async () => {
    const signed = dOrder({ status: 'SIGNED', do_number: 'HC-DO-A', debtor_name: 'BOB LIM' });
    const delivered = dOrder({ status: 'DELIVERED', do_number: 'HC-DO-B' });
    const loaded = dOrder({ status: 'LOADED', do_number: 'HC-DO-C' });
    const app = harness({ dos: [signed, delivered, loaded], lines: [doLine(signed), doLine(delivered), doLine(loaded)] });
    const tab = await get(app, '?status=delivered&sort=do_number:asc');
    expect(tab.status).toBe(200);
    expect(tab.body.deliveryOrders.map((r) => r.do_number)).toEqual(['HC-DO-A', 'HC-DO-B']);
    expect(tab.body.deliveryOrders[0]!.list_row_built).toBe(true);
    expect((await get(app, '?q=bob')).body.deliveryOrders.map((r) => r.do_number)).toEqual(['HC-DO-A']);
  });

  it('serves every delivery order and line in windows of at most 500, past the response ceiling, none twice', async () => {
    const dos: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) { const d = dOrder(); dos.push(d); lines.push(doLine(d)); }
    const app = harness({ dos, lines }, 1, 1_000);
    const seen: string[] = [];
    const nexts: Array<number | null> = [];
    let lineCount = 0;
    for (let offset: number | null = 0, guard = 0; offset !== null && guard < 10; guard += 1) {
      const { body } = await get(app, `?sort=do_number:asc&offset=${offset}`);
      expect(body.total).toBeLessThanOrEqual(500);
      seen.push(...body.deliveryOrders.map((r) => String(r.do_number)));
      lineCount += body.lineCount;
      nexts.push(body.next);
      offset = body.next;
    }
    expect(nexts).toEqual([500, 1_000, null]);
    expect(new Set(seen).size).toBe(1_105);
    expect(lineCount).toBe(1_105);
  });

  it('never exports another company\'s delivery orders or lines, and refuses a caller with no identity', async () => {
    const mine = dOrder();
    const theirs = dOrder({ company_id: 2, do_number: '2990-DO-000001', linked_ac_docno: null });
    const planted = doLine(mine, { company_id: 2, item_code: 'PLANTED' });
    const t = { dos: [mine, theirs], lines: [doLine(mine), doLine(theirs), planted] };
    const one = await get(harness(t, 1));
    expect(one.body.deliveryOrders.map((r) => r.do_number)).toEqual([mine.do_number]);
    expect(one.body.deliveryOrders[0]!.lines.map((l) => l.erp_item_code)).not.toContain('PLANTED');
    expect((await get(harness(t, 2))).body.deliveryOrders.map((r) => r.do_number)).toEqual(['2990-DO-000001']);
    expect((await get(harness(t, 1, null, null))).status).toBe(403);
  });
});

describe('attachDoLines — one line shape for the screen and the file, no prices', () => {
  it('carries no price or amount, and the book\'s item spelling for a delivery order in AutoCount', async () => {
    const [acCode, erpCode] = AC_ITEM_MAP_TSV.split('\n').find((l) => l.startsWith('AERO-Y04 (K)\t'))!.split('\t');
    const book = acBookItemIndex().get(acCode!.toUpperCase())!;
    const d = dOrder({ warehouse_id: 'wh-pg', linked_ac_docno: 'DO-2609-0100', agent: null });
    const own = dOrder({ linked_ac_docno: null, do_number: '2990-DO-000009', debtor_code: '300-X' });
    const t = { dos: [d, own], lines: [doLine(d, { item_code: erpCode, item_group: 'bedframe' }), doLine(own, { item_code: erpCode, item_group: 'bedframe' })] };
    const rows = [{ ...d }, { ...own }] as Array<Row & { id: string; lines?: Row[] }>;
    expect((await attachDoLines(sbFor(t), ctx(1), rows)).error).toBeNull();
    expect(rows[0]).toMatchObject({ ac_doc_no: 'DO-2609-0100', ac_debtor_code: '300-C002' });
    const line = rows[0]!.lines![0]!;
    expect(line).toMatchObject({ item_code: acCode, erp_item_code: erpCode, item_group: book.itemGroup, uom: book.baseUom, location: 'PG', m3: 1.85, delivery_date: '2026-09-05' });
    expect(Object.keys(line).filter((k) => /price|total|amount|discount|sen/i.test(k))).toEqual([]);
    expect(Object.values(line)).not.toContain(250000);
    expect(rows[1]).toMatchObject({ ac_doc_no: '2990-DO-000009', ac_debtor_code: '300-X' });
    expect(rows[1]!.lines![0]).toMatchObject({ item_code: erpCode, item_group: 'bedframe' });
  });

  it('Invoiced / Uninvoiced come from the Pending ledger; cancelled invoices do not count', async () => {
    const d = dOrder();
    const l = doLine(d, { qty: 3 });
    const t = {
      dos: [d], lines: [l],
      siLines: [
        { id: 'sil-1', company_id: 1, do_item_id: l.id, sales_invoice_id: 'si-1', qty: 1 },
        { id: 'sil-2', company_id: 1, do_item_id: l.id, sales_invoice_id: 'si-2', qty: 1 },
      ],
      sis: [
        { id: 'si-1', company_id: 1, invoice_number: 'HC-IV-50', status: 'SENT' },
        { id: 'si-2', company_id: 1, invoice_number: 'HC-IV-49', status: 'CANCELLED' },
      ],
    };
    const rows = [{ ...d }] as Array<Row & { id: string; lines?: Row[] }>;
    expect((await attachDoLines(sbFor(t), ctx(1), rows)).error).toBeNull();
    expect(rows[0]!.lines![0]).toMatchObject({ invoiced_qty: 1, returned_qty: 0, uninvoiced_qty: 2, invoice_nos: ['HC-IV-50'] });
  });
});

describe('the list page reads lines through the same attach', () => {
  it('GET / attaches lines with attachDoLines', () => {
    expect(routeSource).toContain('const withLines = await attachDoLines(sb, c, deliveryOrders);');
    expect(routeSource).toContain('const deliveryOrders = await buildDoListRows(sb, c,');
  });
});
