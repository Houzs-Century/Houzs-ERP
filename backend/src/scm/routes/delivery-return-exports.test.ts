// GET /delivery-returns/export/rows — the Delivery Returns list's ONE export
// over EVERY return its filters match for this caller (owner 2026-09-15), and
// GET / — the list read that shares its filter, stamps and line attach.
//
// Harness follows sales-invoice-exports.test.ts (a view-all caller unless a test
// says otherwise).
//
// WHAT IS ASSERTED:
//   1. Every return past the list's 500-row screen cap and the response ceiling.
//   2. The list's filter: status, SALES SCOPE, company — on the header, the line
//      and every lookup; finance keys stripped for a non-finance caller.
//   3. Each row in the list shape with its lines: AutoCount's item code and
//      Agent spellings (HOUZS only), Description 2 from the variants, Location
//      by the stock rule as the short code, the SO number through the DO line.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { filterDeliveryReturnList } from '../lib/delivery-return-list-read';
import { buildVariantSummary } from '../shared';
import { bookLineItem } from '../../services/autocount-book-item';
import { deliveryReturnExportRowsHandler } from './delivery-return-exports';
import { deliveryReturnListHandler } from './delivery-returns';

type Row = Record<string, unknown>;

let seq = 0;
const dr = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `dr-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    return_number: `HC-DR-2609-${String(seq).padStart(4, '0')}`,
    return_date: '2026-09-10',
    status: 'RECEIVED',
    debtor_code: '300-C002',
    debtor_name: 'Tarrmesh',
    salesperson_id: 'staff-1',
    agent: null,
    delivery_order_id: null,
    do_doc_no: null,
    warehouse_id: 'wh-kl',
    currency: 'MYR',
    local_total_sen: 350000,
    refund_sen: 350000,
    total_cost_sen: 120000,
    total_margin_sen: 230000,
    ...over,
  };
};

const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `dri-${String(seq).padStart(5, '0')}`,
    delivery_return_id: h.id,
    company_id: h.company_id,
    created_at: `2026-09-10T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    do_item_id: null,
    item_code: 'AK-IMMORTAL MATT (Q)',
    item_group: 'mattress',
    description: 'AKEMI IMMORTAL MATTRESS (153x190x36CM)',
    description2: null,
    uom: 'UNIT',
    qty_returned: 1,
    condition: 'GOOD',
    unit_price_sen: 350000,
    discount_sen: 0,
    line_total_sen: 350000,
    notes: null,
    variants: null,
    ...over,
  };
};

type Tables = { drs: Row[]; lines: Row[]; doLines?: Row[]; dos?: Row[]; soLines?: Row[] };

type HarnessOpts = { companyId?: number; companyCode?: string; maxRows?: number | null; viewAll?: boolean; finance?: boolean };

function harness(t: Tables, opts: HarnessOpts = {}) {
  const sb = fakeSb({
    delivery_returns: t.drs,
    delivery_return_items: t.lines,
    delivery_order_items: t.doLines ?? [],
    delivery_orders: t.dos ?? [],
    mfg_sales_order_items: t.soLines ?? [],
    supplier_material_bindings: [],
    staff: [{ id: 'staff-1', name: 'SHELDON' }],
    warehouses: [
      { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
      { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
      { id: 'wh-srw', code: 'SRW WAREHOUSE', name: 'KUCHING WAREHOUSE' },
    ],
  }, {}, [], [], opts.maxRows ?? null);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', (opts.companyId ?? 1) as Variables['companyId']);
    c.set('companyCode', (opts.companyCode ?? 'HOUZS') as Variables['companyCode']);
    if (opts.viewAll !== false) {
      const perms = opts.finance === false ? ['scm.so.view_all'] : ['*'];
      c.set('houzsUser', { id: 7, permissions_set: new Set(perms) } as unknown as Variables['houzsUser']);
    }
    await next();
  });
  app.get('/export/rows', deliveryReturnExportRowsHandler);
  app.get('/', deliveryReturnListHandler);
  return app;
}

type Body = { error?: string; deliveryReturns: Array<Row & { lines: Array<Row & { id: string }> }>; total: number; lineCount: number; truncated: boolean };

const getRows = async (app: ReturnType<typeof harness>, qs = '') => {
  const res = await app.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('the export holds every return, not the screen read', () => {
  it('returns every return past the 500-row list cap and the response ceiling', async () => {
    const drs: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) {
      const h = dr();
      drs.push(h);
      lines.push(line(h), line(h));
    }
    const app = harness({ drs, lines }, { maxRows: 1_000 });
    const { status, body } = await getRows(app);
    expect(status).toBe(200);
    expect(body.total).toBe(1_105);
    expect(body.lineCount).toBe(2_210);
    expect(new Set(body.deliveryReturns.flatMap((r) => r.lines.map((l) => l.id))).size).toBe(2_210);
    expect(body.truncated).toBe(false);

    const list = (await (await app.request('/')).json()) as { deliveryReturns: Row[] };
    expect(list.deliveryReturns).toHaveLength(500);
  });
});

describe('the export follows the list filter, the sales scope and the company', () => {
  it('applies the status, as the list does', async () => {
    const a = dr({ status: 'RECEIVED' });
    const b = dr({ status: 'CANCELLED' });
    const app = harness({ drs: [a, b], lines: [line(a), line(b)] });
    expect((await getRows(app, '?status=CANCELLED')).body.deliveryReturns.map((r) => r.id)).toEqual([b.id]);
    expect((await getRows(app)).body.total).toBe(2);
  });

  it('a caller whose sales scope resolves to nobody exports nothing', async () => {
    const a = dr();
    const app = harness({ drs: [a], lines: [line(a)] }, { viewAll: false });
    const { status, body } = await getRows(app);
    expect(status).toBe(200);
    expect(body.total).toBe(0);
  });

  it('the list filter narrows to the caller\'s salespeople', () => {
    const calls: Array<[string, unknown]> = [];
    const q = {
      in(col: string, v: unknown) { calls.push([`in:${col}`, v]); return q; },
      eq(col: string, v: unknown) { calls.push([`eq:${col}`, v]); return q; },
      order() { return q; },
    };
    filterDeliveryReturnList(q, { status: 'RECEIVED' }, { get: (k: string) => (k === 'companyId' ? 1 : undefined) }, ['staff-1']);
    expect(calls).toEqual([['in:salesperson_id', ['staff-1']], ['eq:status', 'RECEIVED'], ['eq:company_id', 1]]);
  });

  it('never exports another company\'s return, line or link', async () => {
    const mine = dr({ company_id: 1 });
    const theirs = dr({ company_id: 2, return_number: '2990-DR-THEIRS' });
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const linked = line(mine, { do_item_id: 'doi-2' });
    const tables = {
      drs: [mine, theirs],
      lines: [line(mine), linked, planted, line(theirs)],
      doLines: [{ id: 'doi-2', company_id: 2, so_item_id: 'soi-2', delivery_order_id: 'do-2' }],
      soLines: [{ id: 'soi-2', company_id: 2, doc_no: '2990-SO-000001', warehouse_id: 'wh-pg' }],
    };
    const one = await getRows(harness(tables));
    expect(one.body.deliveryReturns.map((r) => r.id)).toEqual([mine.id]);
    const lines = one.body.deliveryReturns[0]!.lines;
    expect(lines.map((l) => l.item_code)).not.toContain('PLANTED');
    expect(lines.map((l) => l.so_doc_no)).not.toContain('2990-SO-000001');
    expect(lines.map((l) => l.location)).toEqual(['KL', 'KL']);
  });

  it('strips cost and margin for a non-finance caller', async () => {
    const a = dr();
    const { body } = await getRows(harness({ drs: [a], lines: [line(a)] }, { finance: false }));
    expect(body.deliveryReturns[0]).not.toHaveProperty('total_cost_sen');
    expect(body.deliveryReturns[0]).not.toHaveProperty('total_margin_sen');
    expect(body.deliveryReturns[0]!.local_total_sen).toBe(350000);
    expect(body.deliveryReturns[0]!.lines[0]).not.toHaveProperty('unit_cost_sen');
  });
});

describe('each row and line in the list shape', () => {
  it('SO number and Location through the DO line, Description 2 from the variants, the book\'s item code and Agent', async () => {
    const h = dr({ delivery_order_id: 'do-1', do_doc_no: 'HC-DO-2609-001', agent: null, warehouse_id: 'wh-kl' });
    const variants = { fabricCode: 'BO315-31', colourLabel: 'Sand' };
    const l = line(h, { do_item_id: 'doi-1', item_code: 'Y04-(K)', item_group: 'bedframe', variants, description2: 'stored', discount_sen: 1000, line_total_sen: 349000 });
    const tables = {
      drs: [h],
      lines: [l],
      doLines: [{ id: 'doi-1', company_id: 1, so_item_id: 'soi-1', delivery_order_id: 'do-1' }],
      dos: [{ id: 'do-1', company_id: 1, so_doc_no: 'HC-SO-013389', warehouse_id: 'wh-pg' }],
      soLines: [{ id: 'soi-1', company_id: 1, doc_no: 'HC-SO-013389', warehouse_id: 'wh-srw' }],
    };
    const { body } = await getRows(harness(tables));
    const row = body.deliveryReturns[0]!;
    /* The account book's item, through the one shared reader. */
    const book = bookLineItem({ itemCode: 'Y04-(K)', description: l.description as string, category: 'bedframe', uom: 'UNIT' }, null);
    expect(book.inBook).toBe(true);
    expect(row.so_doc_no).toBe('HC-SO-013389');
    expect(typeof row.ac_agent).toBe('string');
    expect(row.ac_agent).toBeTruthy();
    expect(row.lines[0]).toMatchObject({
      id: l.id,
      item_code: 'AERO-Y04 (K)',
      description: book.description,
      item_group: book.itemGroup,
      uom: book.uom,
      description2: buildVariantSummary('bedframe', variants),
      location: 'SRW',
      so_doc_no: 'HC-SO-013389',
      qty_returned: 1,
      unit_price_sen: 350000,
      discount_sen: 1000,
      line_total_sen: 349000,
      condition: 'GOOD',
    });
  });

  it('outside the book company: the ERP item code, the salesperson name as Agent, the stored Description 2', async () => {
    const h = dr({ company_id: 2, return_number: '2990-DR-2608-001', agent: 'typed agent' });
    const l = line(h, { item_code: 'Y04-(K)', description2: 'Color :BO315-31' });
    const { body } = await getRows(harness({ drs: [h], lines: [l] }, { companyId: 2, companyCode: '2990' }));
    const row = body.deliveryReturns[0]!;
    expect(row.ac_agent).toBe('SHELDON');
    expect(row.lines[0]).toMatchObject({ item_code: 'Y04-(K)', description2: 'Color :BO315-31', location: 'KL' });
  });

  it('refuses the file when the SO lookup fails; the list still answers', async () => {
    const h = dr({ delivery_order_id: 'do-1' });
    const sb = fakeSb({
      delivery_returns: [h],
      delivery_return_items: [line(h)],
      delivery_orders: [],
      staff: [],
      warehouses: [],
    }, { delivery_orders: ['so_doc_no'] });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      c.set('houzsUser', { id: 7, permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
      await next();
    });
    app.get('/export/rows', deliveryReturnExportRowsHandler);
    app.get('/', deliveryReturnListHandler);
    const res = await app.request('/export/rows');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/delivery orders/);
    const list = await app.request('/');
    expect(list.status).toBe(200);
  });
});
