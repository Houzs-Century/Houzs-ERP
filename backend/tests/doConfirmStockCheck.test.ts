// Confirming a DRAFT delivery order asks the stock question again.
//
// Before 2026-11-10 the DRAFT -> LOADED flip (Confirm, where the stock leaves)
// ran no stock check: a draft saved while stock existed could be confirmed days
// later after that stock went elsewhere, silently driving it negative. Confirm
// now answers 409 short_stock (the same "ship anyway?" the create path asks),
// and a replay with confirmShortStock goes through. Sister: Conts-ERP #787.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchDeliveryOrderStatusHandler } from '../src/scm/routes/delivery-orders-mfg';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; }
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

function harness(opts: { onHand: number; dropship?: boolean }) {
  const tables: Record<string, Row[]> = {
    delivery_orders: [{
      id: 'do-1', do_number: 'HC-DO-1', company_id: CO, status: 'DRAFT', so_doc_no: null,
      warehouse_id: 'w1', is_dropship: opts.dropship === true, migrated_no_stock: false,
    }],
    delivery_order_items: [{
      id: 'l1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'SOFA-1', item_group: null,
      description: 'Sofa', variants: null, qty: 2, company_id: CO,
    }],
    warehouses: [{ id: 'w1', code: 'BLK', name: 'Balakong', company_id: CO, is_active: true }],
    inventory_balances: opts.onHand > 0
      ? [{ warehouse_id: 'w1', item_code: 'SOFA-1', variant_key: '', qty: opts.onHand, company_id: CO }]
      : [],
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/delivery-orders/:id/status', patchDeliveryOrderStatusHandler as never);
  return { app, tables };
}

const confirm = (app: Hono, extra: Row = {}) =>
  app.request('/delivery-orders/do-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'LOADED', ...extra }),
  }, { DO_SHIP_MODE: 'two-step' }); // no database behind these stubs; doShipAtomic.test.ts covers atomic

describe('DO Confirm (DRAFT -> LOADED) re-checks stock', () => {
  test('short stock answers 409 short_stock and the DO stays DRAFT', async () => {
    const { app, tables } = harness({ onHand: 1 });
    const res = await confirm(app);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; shortages?: Array<{ itemCode: string; needed: number; available: number }> };
    expect(body.error).toBe('short_stock');
    expect(body.shortages?.[0]).toMatchObject({ itemCode: 'SOFA-1', needed: 2, available: 1 });
    expect(tables.delivery_orders![0]!.status).toBe('DRAFT');
  });

  test('"ship anyway" (confirmShortStock) confirms it', async () => {
    const { app, tables } = harness({ onHand: 1 });
    const res = await confirm(app, { confirmShortStock: true });
    expect(res.status).toBe(200);
    expect(tables.delivery_orders![0]!.status).toBe('LOADED');
  });

  test('enough stock confirms without asking', async () => {
    const { app, tables } = harness({ onHand: 5 });
    const res = await confirm(app);
    expect(res.status).toBe(200);
    expect(tables.delivery_orders![0]!.status).toBe('LOADED');
  });

  test('a drop-ship DO ships before receipt by choice and is not asked', async () => {
    const { app, tables } = harness({ onHand: 0, dropship: true });
    const res = await confirm(app);
    expect(res.status).toBe(200);
    expect(tables.delivery_orders![0]!.status).toBe('LOADED');
  });
});
