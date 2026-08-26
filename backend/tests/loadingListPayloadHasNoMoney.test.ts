// Loading List — the no-price guarantee (2026-08-25, owner: "仓库线只扫码置
// LOADED 不见价格"). The warehouse queue must never carry money. This drives the
// real handler with a fake PostgREST whose .select() PROJECTS to the requested
// column list — so a money column that is present in the stored row but absent
// from the route's HEADER / ITEM allowlist is dropped exactly as PostgREST would
// drop it. That makes the assertion test the ACTUAL select strings, not the
// fixture: seed local_total_sen / line_total_sen / unit_cost_sen on every row,
// then assert not one of them survives into the payload.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { loadingListHandler } from '../src/scm/routes/loading-list';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private cols: string[] | null = null;
  constructor(private rows: Row[]) {}
  // Parse the comma-separated select list so run() can project like PostgREST.
  select(cols?: string) {
    this.cols = cols ? cols.split(',').map((s) => s.trim()).filter(Boolean) : null;
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  gte(col: string, val: unknown) { this.preds.push((r) => r[col] != null && r[col] >= (val as any)); return this; }
  lte(col: string, val: unknown) { this.preds.push((r) => r[col] != null && r[col] <= (val as any)); return this; }
  order() { return this; }
  limit() { return this; }
  private project(r: Row): Row {
    if (!this.cols) return r;
    const out: Row = {};
    for (const c of this.cols) if (c in r) out[c] = r[c];
    return out;
  }
  private run(): Row[] {
    return this.rows.filter((r) => this.preds.every((p) => p(r))).map((r) => this.project(r));
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

const MONEY = { local_total_sen: 999999, total_cost_sen: 5000, total_margin_sen: 4000 };
const LINE_MONEY = { unit_price_sen: 12345, line_total_sen: 67890, unit_cost_sen: 111, line_cost_sen: 222, line_margin_sen: 333 };

function app(tables: Record<string, Row[]>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery((tables[t] ||= [])) } as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  a.get('/loading-list', loadingListHandler as never);
  return a;
}

function seed() {
  return {
    delivery_orders: [
      { id: 'do-1', do_number: 'DO-1', status: 'DRAFT', company_id: 1, debtor_name: 'Acme', city: 'KL', state: 'Selangor', customer_delivery_date: '2026-08-27', vehicle: 'WXY-1', driver_name: 'Ali', ...MONEY },
      { id: 'do-2', do_number: 'DO-2', status: 'LOADED', company_id: 1, debtor_name: 'Beta', city: 'JB', state: 'Johor', customer_delivery_date: '2026-08-28', vehicle: null, driver_name: null, ...MONEY },
      // Other company — must never appear (company scope).
      { id: 'do-9', do_number: 'DO-9', status: 'DRAFT', company_id: 2, debtor_name: 'Other Co', ...MONEY },
    ],
    delivery_order_items: [
      { id: 'l-1', delivery_order_id: 'do-1', item_code: 'SOFA-A', description: 'Sofa A', qty: 2, uom: 'set', item_group: 'sofa', variants: null, rack_id: 'r1', ...LINE_MONEY },
      { id: 'l-2', delivery_order_id: 'do-1', item_code: 'BF-01', description: 'Bedframe', qty: 3, uom: 'pc', item_group: 'bedframe', variants: null, rack_id: null, ...LINE_MONEY },
      { id: 'l-3', delivery_order_id: 'do-2', item_code: 'ACC-1', description: 'Pillow', qty: 5, uom: 'pc', item_group: 'accessories', variants: null, rack_id: null, ...LINE_MONEY },
    ],
    delivery_order_crew: [
      { do_id: 'do-1', lorry_plate: 'ABC-1234', driver_1_name: 'Ali Bin' },
    ],
  };
}

const get = (a: Hono, qs = '') => a.request(`/loading-list${qs}`).then((r) => r.json());

describe('loading list — no money in the payload, ever', () => {
  test('not one *_sen / cost / margin / price key survives into the payload', async () => {
    const body = await get(app(seed()), '?status=all');
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/_sen/);
    expect(json.toLowerCase()).not.toContain('cost');
    expect(json.toLowerCase()).not.toContain('margin');
    expect(json).not.toContain('unit_price');
    // Sanity: it DID return the queue (so the assertion above is not vacuous).
    expect(body.deliveryOrders.length).toBeGreaterThan(0);
  });

  test('carries what a picker needs — product, qty, destination, lorry', async () => {
    const body = await get(app(seed()), '?status=all');
    const do1 = body.deliveryOrders.find((d: any) => d.do_number === 'DO-1');
    expect(do1.debtor_name).toBe('Acme');
    expect(do1.city).toBe('KL');
    expect(do1.lorry_plate).toBe('ABC-1234'); // crew plate preferred over header vehicle
    expect(do1.loading_lines).toHaveLength(2);
    expect(do1.loading_qty_total).toBe(5); // 2 + 3
    const sofa = do1.loading_lines.find((l: any) => l.itemCode === 'SOFA-A');
    expect(sofa.qty).toBe(2);
    expect(sofa.description).toBe('Sofa A');
  });

  test('status=to_load returns DRAFT only; loaded returns LOADED only', async () => {
    const toLoad = await get(app(seed()), '?status=to_load');
    expect(toLoad.deliveryOrders.map((d: any) => d.do_number)).toEqual(['DO-1']);
    const loaded = await get(app(seed()), '?status=loaded');
    expect(loaded.deliveryOrders.map((d: any) => d.do_number)).toEqual(['DO-2']);
  });

  test('default (no status) behaves as to_load', async () => {
    const body = await get(app(seed()));
    expect(body.deliveryOrders.map((d: any) => d.do_number)).toEqual(['DO-1']);
  });

  test('company scope — the other company’s DO never appears', async () => {
    const body = await get(app(seed()), '?status=all');
    expect(body.deliveryOrders.map((d: any) => d.do_number)).not.toContain('DO-9');
  });

  test('lorry falls back to the header vehicle when no crew row exists', async () => {
    const tables = seed();
    tables.delivery_order_crew = []; // no board assignment
    tables.delivery_orders[0].vehicle = 'HEADER-9';
    const body = await get(app(tables), '?status=to_load');
    expect(body.deliveryOrders[0].lorry_plate).toBe('HEADER-9');
  });
});
