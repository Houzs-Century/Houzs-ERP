// A DRAFT delivery order opens before the goods arrive; Confirm asks.
//
// Owner 2026-11-18: "Sometimes the goods are not in stock yet, so we open the
// DO first. I expect stock tonight; I do the GR, and the lorry can deliver in
// the meantime. ... after delivering, the office just presses Confirm and it
// ships." So:
//   (a) a create with asDraft and short stock succeeds, lands DRAFT and writes
//       no inventory movement (the same body without asDraft still gets 409
//       short_stock, so the pass is not the harness skipping the check);
//   (b) Confirm with short stock answers 409 short_stock (doConfirmStockCheck
//       pins the replay); Confirm of a draft whose SO line is not READY answers
//       409 items_not_ready, and the replay with confirmNotReady goes on;
//   (c) Confirm once the GR is in ships with no dialog and writes the OUT.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { createDeliveryOrderHandler, patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';


const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = (Array.isArray(v) ? v : [v]).map((r) => ({ id: `id-${Math.random().toString(36).slice(2)}`, ...r })); return this; }
  upsert(v: Row | Row[]) { return this.insert(v); }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  order() { return this; } limit() { return this; } range() { return this; } ilike() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; } filter() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

function app(tables: Record<string, Row[]>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS', name: 'Houzs Century' }] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  a.post('/delivery-orders-mfg', createDeliveryOrderHandler as never);
  return a;
}

const ENV = { DO_SHIP_MODE: 'two-step' }; // no database behind these stubs; doShipAtomic.test.ts covers atomic
const send = (a: Hono, method: string, url: string, body: Row) =>
  a.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ENV);
const outRows = (t: Record<string, Row[]>) => (t.inventory_movements ?? []).filter((m) => m.movement_type === 'OUT');

describe('(a) a draft opens with short stock and moves nothing', () => {
  const tables = (): Record<string, Row[]> => ({
    mfg_products: [{ code: 'MAT-1', status: 'ACTIVE', company_id: CO, category: 'MATTRESS', model: { active: true } }],
    warehouses: [{ id: 'w1', code: 'BLK', name: 'Balakong', company_id: CO, is_active: true, is_default: true }],
    inventory_balances: [], // nothing on hand: the GR comes tonight
    delivery_orders: [], delivery_order_items: [], inventory_movements: [],
  });
  const body = { debtorName: 'Cust', warehouseId: 'w1', items: [{ itemCode: 'MAT-1', description: 'Mattress', qty: 2 }] };

  test('without asDraft the create still asks "ship anyway?"', async () => {
    const t = tables();
    const res = await send(app(t), 'POST', '/delivery-orders-mfg', body);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('short_stock');
    expect(t.delivery_orders).toHaveLength(0);
  });

  test('with asDraft it is created DRAFT, with no stock movement', async () => {
    const t = tables();
    const res = await send(app(t), 'POST', '/delivery-orders-mfg', { ...body, asDraft: true });
    expect(res.status).toBeLessThan(300);
    expect(t.delivery_orders).toHaveLength(1);
    expect(t.delivery_orders![0]!.status).toBe('DRAFT');
    expect(t.inventory_movements).toHaveLength(0);
  });
});

function confirmTables(opts: { onHand: number; soLineStock?: string }): Record<string, Row[]> {
  return {
    delivery_orders: [{
      id: 'do-1', do_number: 'HC-DO-1', company_id: CO, status: 'DRAFT', so_doc_no: null,
      warehouse_id: 'w1', is_dropship: false, migrated_no_stock: false,
    }],
    delivery_order_items: [{
      id: 'l1', delivery_order_id: 'do-1', so_item_id: opts.soLineStock ? 'soi-1' : null, item_code: 'MAT-1', item_group: null,
      description: 'Mattress', variants: null, qty: 2, company_id: CO,
    }],
    mfg_sales_order_items: opts.soLineStock ? [{
      id: 'soi-1', doc_no: 'HC-SO-1', item_code: 'MAT-1', item_group: 'MATTRESS', description: 'Mattress',
      stock_status: opts.soLineStock, warehouse_id: 'w1', company_id: CO, qty: 2, cancelled: false,
    }] : [],
    mfg_sales_orders: opts.soLineStock ? [{ doc_no: 'HC-SO-1', company_id: CO, status: 'CONFIRMED' }] : [],
    warehouses: [{ id: 'w1', code: 'BLK', name: 'Balakong', company_id: CO, is_active: true }],
    inventory_balances: opts.onHand > 0
      ? [{ warehouse_id: 'w1', item_code: 'MAT-1', variant_key: '', qty: opts.onHand, company_id: CO }]
      : [],
    inventory_movements: [],
  };
}

describe('(b) Confirm asks the stock questions against stock as it is now', () => {
  test('short stock at Confirm is 409 short_stock and nothing ships', async () => {
    const t = confirmTables({ onHand: 0 });
    const res = await send(app(t), 'PATCH', '/delivery-orders/do-1/status', { status: 'LOADED' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('short_stock');
    expect(t.delivery_orders![0]!.status).toBe('DRAFT');
    expect(outRows(t)).toHaveLength(0);
  });

  test('a linked SO line that is not READY is 409 items_not_ready; confirmNotReady goes on', async () => {
    const t = confirmTables({ onHand: 5, soLineStock: 'PENDING' });
    const a = app(t);
    const res = await send(a, 'PATCH', '/delivery-orders/do-1/status', { status: 'LOADED' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('items_not_ready');
    expect(t.delivery_orders![0]!.status).toBe('DRAFT');
    const replay = await send(a, 'PATCH', '/delivery-orders/do-1/status', { status: 'LOADED', confirmNotReady: true });
    expect(((await replay.clone().json()) as Row).error).not.toBe('items_not_ready');
  });
});

describe('(c) Confirm after the GR ships with no dialog', () => {
  test('enough stock: LOADED and the OUT is written', async () => {
    const t = confirmTables({ onHand: 5 });
    const res = await send(app(t), 'PATCH', '/delivery-orders/do-1/status', { status: 'LOADED' });
    expect(res.status).toBe(200);
    expect(t.delivery_orders![0]!.status).toBe('LOADED');
    expect(outRows(t).length).toBeGreaterThan(0);
  });
});
