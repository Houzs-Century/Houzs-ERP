/* A partly delivered Sales Order: the delivered line is FROZEN, its undelivered
   sibling is still editable (owner ruling 2026-09-15, shared/so-line-freeze.ts).

   Before this ruling one live Delivery Order anywhere on the order refused EVERY
   line write with so_has_downstream, so the undelivered half could not be
   changed at all — the tests below that expect the sibling to go through are
   the ones that were RED against that code.

   Harness: the REAL mfgSalesOrders router (its handlers are inline) on a Hono
   app over a permissive fake PostgREST builder. The caller is already the
   pinned SCM system identity, which is what makes supabaseAuth pass through
   (its run-once guard), so no session is needed. */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private failTable: boolean) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  like() { return this; }
  gte() { return this; }
  lte() { return this; }
  gt() { return this; }
  lt() { return this; }
  not() { return this; }
  or() { return this; }
  filter() { return this; }
  contains() { return this; }
  is(col: string, val: unknown) { this.preds.push((r) => (r[col] ?? null) === val); return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  upsert(p: Row | Row[]) { this.op = 'upsert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] {
    if (this.op === 'insert' || this.op === 'upsert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  private result(data: unknown) {
    return this.failTable ? { data: null, error: { message: 'boom' }, count: null } : { data, error: null, count: Array.isArray(data) ? data.length : null };
  }
  maybeSingle() { const h = this.run(); return Promise.resolve(this.result(h[0] ?? null)); }
  single() { const h = this.run(); return Promise.resolve(this.result(h[0] ?? null)); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve(this.result(this.run())).then(res, rej);
  }
}

const DOC = 'HC-SO-2609-001';
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

let tables: Record<string, Row[]>;
let failing: Set<string>;

beforeEach(() => {
  failing = new Set();
  tables = {
    mfg_sales_orders: [{
      doc_no: DOC, company_id: 1, status: 'READY_TO_SHIP', processing_date: null,
      salesperson_id: 9, version: 4,
      edit_lease_token: 'lease-1', edit_lease_expires_at: future(), edit_lease_user_id: 9,
    }],
    mfg_sales_order_items: [
      { id: 'line-delivered', doc_no: DOC, company_id: 1, item_code: 'BF-QUEEN', item_group: 'bedframe', qty: 3, unit_price_sen: 100000, total_sen: 300000, discount_sen: 0, cancelled: false, variants: {}, line_no: 1 },
      { id: 'line-open', doc_no: DOC, company_id: 1, item_code: 'MT-QUEEN', item_group: 'mattress', qty: 1, unit_price_sen: 50000, total_sen: 50000, discount_sen: 0, cancelled: false, variants: {}, line_no: 2 },
    ],
    /* A DRAFT delivery order that carries ONE of the three bedframes: partly
       delivered, and on a draft — both still freeze the line. */
    delivery_orders: [{ id: 'do-1', so_doc_no: DOC, status: 'DRAFT', company_id: 1 }],
    delivery_order_items: [{ id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'line-delivered', qty: 1 }],
    sales_invoices: [],
    sales_invoice_items: [],
    mfg_products: [{ code: 'MT-QUEEN', status: 'ACTIVE', company_id: 1 }],
  };
});

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), failing.has(t)),
      rpc: async () => ({ data: null, error: null }),
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID, user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.route('/mfg-sales-orders', mfgSalesOrders as never);
  return a;
}

const env = {} as never;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as never;
const call = (method: string, path: string, body?: Row) =>
  app().request(`/mfg-sales-orders/${DOC}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'X-SO-Edit-Lease': 'lease-1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env, ctx);

describe('a line already on a Delivery Order is frozen', () => {
  test('editing the delivered line is refused with so_line_frozen', async () => {
    const res = await call('PATCH', '/items/line-delivered', { remark: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_line_frozen');
  });

  test('deleting the delivered line is refused, and the row survives', async () => {
    const res = await call('DELETE', '/items/line-delivered');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_line_frozen');
    expect(tables.mfg_sales_order_items.some((l) => l.id === 'line-delivered')).toBe(true);
  });

  test('a line on a SALES INVOICE is frozen too', async () => {
    tables.delivery_orders = [];
    tables.delivery_order_items = [];
    tables.sales_invoices = [{ id: 'si-1', so_doc_no: DOC, status: 'SENT' }];
    tables.sales_invoice_items = [{ id: 'sii-1', sales_invoice_id: 'si-1', so_item_id: 'line-delivered', do_item_id: null }];
    const res = await call('DELETE', '/items/line-delivered');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_line_frozen');
  });

  test('an unreadable delivery-order line refuses rather than reading as undelivered', async () => {
    failing.add('delivery_order_items');
    const res = await call('DELETE', '/items/line-open');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('downstream_check_failed');
  });
});

describe('the undelivered sibling on the same order stays editable', () => {
  test('deleting the undelivered line goes through', async () => {
    const res = await call('DELETE', '/items/line-open');
    expect(res.status).toBe(204);
    expect(tables.mfg_sales_order_items.map((l) => l.id)).toEqual(['line-delivered']);
  });

  test('editing the undelivered line is not refused by the downstream lock', async () => {
    const res = await call('PATCH', '/items/line-open', { remark: 'call before delivery' });
    const body = res.status === 409 ? await res.json() : null;
    expect(body?.error).not.toBe('so_has_downstream');
    expect(body?.error).not.toBe('so_line_frozen');
  });

  test('a new line may still be added while something is left to convert', async () => {
    const res = await call('POST', '/items', { itemCode: 'MT-QUEEN', qty: 1 });
    const body = res.status === 409 ? await res.json() : null;
    expect(body?.error).not.toBe('so_has_downstream');
  });

  test('a cancelled delivery order frees its line again', async () => {
    tables.delivery_orders[0].status = 'CANCELLED';
    const res = await call('DELETE', '/items/line-delivered');
    expect(res.status).toBe(204);
  });
});

describe('an order with nothing left to convert behaves as the old locked order', () => {
  test('adding a line to a fully frozen order is refused', async () => {
    tables.delivery_order_items.push({ id: 'doi-2', delivery_order_id: 'do-1', so_item_id: 'line-open', qty: 1 });
    const res = await call('POST', '/items', { itemCode: 'MT-QUEEN', qty: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_has_downstream');
  });

  test('a downstream line naming no SO line freezes every line (fail closed)', async () => {
    tables.delivery_order_items = [{ id: 'doi-x', delivery_order_id: 'do-1', so_item_id: null, qty: 1 }];
    const res = await call('DELETE', '/items/line-open');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_line_frozen');
  });
});
