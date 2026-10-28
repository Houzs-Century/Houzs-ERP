/* DEV-32 (Syu 2026-10-01): with `scm.so.edit_after_do`, Logistics changes a
   Sales Order after its Delivery Order, and the DO follows — charge lines
   (SERVICE SKUs) added or edited, and the customer details. A DO with a live
   invoice or return stays locked (shared/so-after-do-edit.ts).

   Same harness as soLineFreezeRoutes.test.ts: the REAL mfgSalesOrders router on
   a permissive fake PostgREST builder, here also minting ids on insert. The
   fixture is HC-SO-013143's shape: a DELIVERED order whose processing date has
   passed and whose every line is on one DO, so every line write is refused. */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';

type Row = Record<string, any>;
let seq = 0;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[]) {}
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
    if (this.op === 'insert' || this.op === 'upsert') {
      for (const r of this.inserted) r.id ??= `new-${++seq}`;
      this.rows.push(...this.inserted);
      return this.inserted;
    }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  private result(data: unknown) {
    return { data, error: null, count: Array.isArray(data) ? data.length : null };
  }
  maybeSingle() { const h = this.run(); return Promise.resolve(this.result(h[0] ?? null)); }
  single() { const h = this.run(); return Promise.resolve(this.result(h[0] ?? null)); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve(this.result(this.run())).then(res, rej);
  }
}

const DOC = 'HC-SO-2608-143';
const future = () => new Date(Date.now() + 10 * 60_000).toISOString();

let tables: Record<string, Row[]>;
let perms: Set<string>;

beforeEach(() => {
  perms = new Set(['scm.so.edit_after_do', 'scm.so.view_all']); // view_all: no D1 sales-scope read in this harness
  tables = {
    mfg_sales_orders: [{
      doc_no: DOC, company_id: 1, status: 'DELIVERED', processing_date: '2026-08-06',
      salesperson_id: 9, version: 4, phone: '+60162336952', debtor_name: 'CHEW WEE LAU', email: 'chew@example.com',
      address1: '1 Jalan Satu', postcode: '62000', city: 'Putrajaya', customer_state: 'Putrajaya', customer_delivery_date: '2026-10-02',
      edit_lease_token: 'lease-1', edit_lease_expires_at: future(), edit_lease_user_id: 9,
    }],
    mfg_sales_order_items: [
      { id: 'line-bed', doc_no: DOC, company_id: 1, item_code: 'BF-QUEEN', item_group: 'bedframe', qty: 1, unit_price_sen: 100000, total_sen: 100000, discount_sen: 0, cancelled: false, variants: {}, line_no: 1 },
      { id: 'line-svc', doc_no: DOC, company_id: 1, item_code: 'SVC-TRANSPORT', item_group: 'service', qty: 1, unit_price_sen: 5000, total_sen: 5000, discount_sen: 0, cancelled: false, variants: {}, line_no: 2 },
    ],
    delivery_orders: [{ id: 'do-1', do_number: 'HC-DO-2610-011', so_doc_no: DOC, status: 'LOADED', company_id: 1, phone: '+60162336952' }],
    delivery_order_items: [
      { id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'line-bed', qty: 1, company_id: 1, line_no: 1 },
      { id: 'doi-2', delivery_order_id: 'do-1', so_item_id: 'line-svc', qty: 1, unit_price_sen: 5000, company_id: 1, line_no: 2 },
    ],
    sales_invoices: [],
    sales_invoice_items: [],
    delivery_returns: [],
    mfg_products: [
      { code: 'SVC-STORAGE', status: 'ACTIVE', company_id: 1, category: 'SERVICE' },
      { code: 'SVC-TRANSPORT', status: 'ACTIVE', company_id: 1, category: 'SERVICE' },
      { code: 'MT-QUEEN', status: 'ACTIVE', company_id: 1, category: 'MATTRESS' },
    ],
  };
});

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= [])),
      rpc: async (name: string, args: Row) => {
        if (name !== 'apply_so_header_cas') return { data: null, error: null };
        const so = tables.mfg_sales_orders[0];
        Object.assign(so, args.p_patch, { version: so.version + 1 });
        return { data: [{ applied: true, current_version: so.version }], error: null };
      },
    } as never);
    c.set('companyId' as never, 1 as never);
    c.set('companyCode' as never, 'HC' as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID, user_metadata: { name: 'Tester' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: perms } as never);
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

describe('adding a charge line after the DO', () => {
  test('without the after-DO road the delivered order still refuses a new line', async () => {
    const res = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, unitPriceSen: 8000 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_has_downstream');
  });

  test('a caller without the permission is refused', async () => {
    perms = new Set(['scm.so.view_all']);
    const res = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, unitPriceSen: 8000, afterDo: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden_edit_after_do');
  });

  test('a product (not a charge) is refused, whatever item_group the client claims', async () => {
    const res = await call('POST', '/items', { itemCode: 'MT-QUEEN', itemGroup: 'service', qty: 1, afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_service_only');
  });

  test('the charge lands on the SO and on its one DO, linked to the new SO line', async () => {
    const res = await call('POST', '/items', { itemCode: 'SVC-STORAGE', itemGroup: 'service', qty: 1, unitPriceSen: 8000, afterDo: true });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.doNumber).toBe('HC-DO-2610-011');
    expect(body.doCopyFailed).toBeUndefined();
    const soLine = tables.mfg_sales_order_items.find((l) => l.item_code === 'SVC-STORAGE');
    expect(soLine).toBeDefined();
    const doLine = tables.delivery_order_items.find((l) => l.item_code === 'SVC-STORAGE');
    expect(doLine).toMatchObject({ delivery_order_id: 'do-1', so_item_id: soLine!.id, qty: 1, unit_price_sen: 8000, line_total_sen: 8000 });
  });

  test('with two open DOs the caller must pick one, and the pick is honoured', async () => {
    tables.delivery_orders.push({ id: 'do-2', do_number: 'HC-DO-2610-020', so_doc_no: DOC, status: 'LOADED', company_id: 1 });
    const unpicked = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, afterDo: true });
    expect(unpicked.status).toBe(409);
    expect((await unpicked.json()).error).toBe('after_do_pick_do');
    expect(tables.mfg_sales_order_items.some((l) => l.item_code === 'SVC-STORAGE')).toBe(false);

    const picked = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, afterDo: true, targetDoId: 'do-2' });
    expect(picked.status).toBe(201);
    expect(tables.delivery_order_items.find((l) => l.item_code === 'SVC-STORAGE')?.delivery_order_id).toBe('do-2');
  });

  test('a DO with a live invoice stays locked, and nothing is written', async () => {
    tables.sales_invoices = [{ id: 'si-1', so_doc_no: DOC, delivery_order_id: 'do-1', status: 'SENT' }];
    const res = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_target_locked');
    expect(tables.mfg_sales_order_items).toHaveLength(2);
  });

  test('a DO with a live delivery return stays locked too', async () => {
    tables.delivery_returns = [{ id: 'dr-1', delivery_order_id: 'do-1', status: 'RECEIVED' }];
    const res = await call('POST', '/items', { itemCode: 'SVC-STORAGE', qty: 1, afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_target_locked');
  });
});

describe('editing a charge line the DO already carries', () => {
  test('the SO line and its DO line both take the new amount', async () => {
    const res = await call('PATCH', '/items/line-svc', { itemCode: 'SVC-TRANSPORT', qty: 1, unitPriceSen: 12000, afterDo: true });
    expect(res.status).toBe(200);
    expect(tables.mfg_sales_order_items.find((l) => l.id === 'line-svc')?.unit_price_sen).toBe(12000);
    expect(tables.delivery_order_items.find((l) => l.id === 'doi-2')).toMatchObject({ unit_price_sen: 12000, line_total_sen: 12000 });
  });

  test('a product line the DO carries stays frozen', async () => {
    const res = await call('PATCH', '/items/line-bed', { remark: 'x', afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_service_only');
  });

  test('swapping the charge for another code is refused', async () => {
    const res = await call('PATCH', '/items/line-svc', { itemCode: 'SVC-STORAGE', afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_service_only');
  });

  test('without the after-DO road the frozen charge line is still refused', async () => {
    const res = await call('PATCH', '/items/line-svc', { unitPriceSen: 12000 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('so_line_frozen');
  });
});

describe('changing the customer details after the DO', () => {
  test('the new phone is saved on the SO and copied onto the DO', async () => {
    const res = await call('PATCH', '', { phone: '+60123456789', version: 4, afterDo: true });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.doCopied).toEqual(['HC-DO-2610-011']);
    expect(body.doCopyFailed).toEqual([]);
    expect(tables.mfg_sales_orders[0].phone).toBe('+60123456789');
    expect(tables.delivery_orders[0].phone).toBe('+60123456789');
  });

  test('without the after-DO road the phone stays locked (processing lock, then identity lock)', async () => {
    const res = await call('PATCH', '', { phone: '+60123456789', version: 4 });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(['so_locked_processing', 'so_identity_locked']).toContain(body.error);
    expect(tables.delivery_orders[0].phone).toBe('+60162336952');
  });

  test('a column the permission does not unlock is still refused, by name', async () => {
    const res = await call('PATCH', '', { ref: 'NEW-REF', version: 4, afterDo: true });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe('so_identity_locked');
    expect(body.lockedFields).toEqual(['ref']);
  });

  test('an invoiced DO keeps the customer details locked on the SO and the DO', async () => {
    tables.sales_invoices = [{ id: 'si-1', so_doc_no: DOC, delivery_order_id: 'do-1', status: 'SENT' }];
    const res = await call('PATCH', '', { phone: '+60123456789', version: 4, afterDo: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_target_locked');
    expect(tables.mfg_sales_orders[0].phone).toBe('+60162336952');
  });
});
