/* DEV-70 (syasya 2026-10-12): with `scm.so.edit_price_after_do`, the unit price
   and discount of a line a Delivery Order already carries can change — product
   lines too — and every DO line carrying it follows, and every live invoice
   line billing those DO lines, issued or not (Nico 2026-10-13, option B). Qty
   stays as delivered; a DO with a live Delivery Return stays locked
   (shared/so-after-do-edit.ts).

   Harness copied from soAfterDoEditRoutes.test.ts. The fixture is
   HC-SO-013490's shape: a DELIVERED order whose product lines came across at
   RM 0; the mattress line was delivered over two DOs. */
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
  perms = new Set(['scm.so.edit_price_after_do', 'scm.so.view_all']); // view_all: no D1 sales-scope read in this harness
  tables = {
    mfg_sales_orders: [{
      doc_no: DOC, company_id: 1, status: 'DELIVERED', processing_date: '2026-08-06',
      salesperson_id: 9, version: 4, phone: '+60162336952', debtor_name: 'CHEW WEE LAU', email: 'chew@example.com',
      address1: '1 Jalan Satu', postcode: '62000', city: 'Putrajaya', customer_state: 'Putrajaya', customer_delivery_date: '2026-10-02',
      edit_lease_token: 'lease-1', edit_lease_expires_at: future(), edit_lease_user_id: 9,
    }],
    mfg_sales_order_items: [
      { id: 'line-mat', doc_no: DOC, company_id: 1, item_code: 'MT-QUEEN', item_group: 'mattress', qty: 2, unit_price_sen: 0, total_sen: 0, discount_sen: 0, line_cost_sen: 60000, cancelled: false, variants: {}, line_no: 1 },
      { id: 'line-bed', doc_no: DOC, company_id: 1, item_code: 'BF-QUEEN', item_group: 'bedframe', qty: 1, unit_price_sen: 0, total_sen: 0, discount_sen: 0, line_cost_sen: 0, cancelled: false, variants: {}, line_no: 2 },
      { id: 'line-new', doc_no: DOC, company_id: 1, item_code: 'PL-PILLOW', item_group: 'accessory', qty: 1, unit_price_sen: 0, total_sen: 0, discount_sen: 0, cancelled: false, variants: {}, line_no: 3 },
    ],
    delivery_orders: [
      { id: 'do-1', do_number: 'HC-DO-2610-011', so_doc_no: DOC, status: 'DELIVERED', company_id: 1 },
      { id: 'do-2', do_number: 'HC-DO-2610-012', so_doc_no: DOC, status: 'DELIVERED', company_id: 1 },
    ],
    delivery_order_items: [
      { id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'line-mat', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, line_cost_sen: 30000, company_id: 1, line_no: 1 },
      { id: 'doi-2', delivery_order_id: 'do-2', so_item_id: 'line-mat', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, line_cost_sen: 30000, company_id: 1, line_no: 1 },
      { id: 'doi-3', delivery_order_id: 'do-1', so_item_id: 'line-bed', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, line_cost_sen: 0, company_id: 1, line_no: 2 },
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

const doLine = (id: string) => tables.delivery_order_items.find((r) => r.id === id)!;
const soLine = (id: string) => tables.mfg_sales_order_items.find((r) => r.id === id)!;
const reprice = (itemId: string, body: Row) => call('POST', `/items/${itemId}/price-after-do`, body);

describe('changing a delivered line price', () => {
  test('without the permission it is refused and nothing moves', async () => {
    perms = new Set(['scm.so.edit_after_do', 'scm.so.view_all']);
    const res = await reprice('line-bed', { unitPriceSen: 250000, discountSen: 0 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden_edit_price_after_do');
    expect(soLine('line-bed').unit_price_sen).toBe(0);
    expect(doLine('doi-3').unit_price_sen).toBe(0);
  });

  test('a product line takes the new price and its DO line follows', async () => {
    const res = await reprice('line-bed', { unitPriceSen: 250000, discountSen: 10000, reason: 'Price missed at import' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, doNumbers: ['HC-DO-2610-011'] });
    expect(soLine('line-bed')).toMatchObject({ qty: 1, unit_price_sen: 250000, discount_sen: 10000, total_sen: 240000, balance_sen: 240000 });
    expect(doLine('doi-3')).toMatchObject({ qty: 1, unit_price_sen: 250000, discount_sen: 10000, line_total_sen: 240000 });
  });

  test('a line delivered over two DOs: each DO line keeps its qty and takes half the discount', async () => {
    const res = await reprice('line-mat', { unitPriceSen: 99900, discountSen: 1001 });
    expect(res.status).toBe(200);
    expect((await res.json()).doNumbers).toEqual(['HC-DO-2610-011', 'HC-DO-2610-012']);
    expect(soLine('line-mat')).toMatchObject({ qty: 2, total_sen: 198799, line_margin_sen: 198799 - 60000 });
    expect(doLine('doi-1')).toMatchObject({ qty: 1, unit_price_sen: 99900, discount_sen: 501, line_total_sen: 99399 });
    expect(doLine('doi-2')).toMatchObject({ qty: 1, unit_price_sen: 99900, discount_sen: 500, line_total_sen: 99400 });
  });

  test('qty in the request is ignored: only price and discount are read', async () => {
    const res = await reprice('line-bed', { unitPriceSen: 1000, discountSen: 0, qty: 5 });
    expect(res.status).toBe(200);
    expect(soLine('line-bed').qty).toBe(1);
  });

  test('an issued invoice on the DO follows: its line, its total and its History (HC-SI-2610-103)', async () => {
    tables.sales_invoices.push({ id: 'si-1', invoice_number: 'HC-SI-2610-103', delivery_order_id: 'do-1', so_doc_no: DOC, status: 'SENT', total_sen: 0, company_id: 1 });
    tables.sales_invoice_items.push(
      { id: 'sii-1', sales_invoice_id: 'si-1', do_item_id: 'doi-3', item_code: 'BF-QUEEN', item_group: 'bedframe', qty: 1, unit_price_sen: 0, discount_sen: 0, tax_sen: 0, line_total_sen: 0, line_cost_sen: 0, company_id: 1 },
      { id: 'sii-2', sales_invoice_id: 'si-1', do_item_id: 'doi-1', item_code: 'MT-QUEEN', item_group: 'mattress', qty: 1, unit_price_sen: 0, discount_sen: 0, tax_sen: 0, line_total_sen: 0, line_cost_sen: 0, company_id: 1 },
    );
    const res = await reprice('line-bed', { unitPriceSen: 850000, discountSen: 0 });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('siCopyFailed');
    expect(soLine('line-bed').unit_price_sen).toBe(850000);
    expect(doLine('doi-3').unit_price_sen).toBe(850000);
    expect(tables.sales_invoice_items.find((r) => r.id === 'sii-1')).toMatchObject({ unit_price_sen: 850000, line_total_sen: 850000 });
    expect(tables.sales_invoice_items.find((r) => r.id === 'sii-2')).toMatchObject({ unit_price_sen: 0, line_total_sen: 0 });
    expect(tables.sales_invoices[0]).toMatchObject({ total_sen: 850000 });
    expect((tables.entity_audit_log ?? []).find((r) => r.entity_type === 'SALES_INVOICE' && r.entity_id === 'si-1')?.note)
      .toContain('price after DO');
  });

  test('a cancelled invoice is left alone', async () => {
    tables.sales_invoices.push({ id: 'si-x', invoice_number: 'HC-SI-2610-090', delivery_order_id: 'do-1', so_doc_no: DOC, status: 'CANCELLED', total_sen: 0, company_id: 1 });
    tables.sales_invoice_items.push({ id: 'sii-x', sales_invoice_id: 'si-x', do_item_id: 'doi-3', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, company_id: 1 });
    expect((await reprice('line-bed', { unitPriceSen: 850000, discountSen: 0 })).status).toBe(200);
    expect(tables.sales_invoice_items.find((r) => r.id === 'sii-x')!.unit_price_sen).toBe(0);
  });

  test('a DO with a live Delivery Return stays locked', async () => {
    tables.delivery_returns.push({ id: 'dr-1', delivery_order_id: 'do-1', status: 'POSTED', company_id: 1 });
    const res = await reprice('line-bed', { unitPriceSen: 250000, discountSen: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_price_returned');
    expect(soLine('line-bed').unit_price_sen).toBe(0);
  });

  test('an order invoiced without a DO is refused', async () => {
    tables.sales_invoices.push({ id: 'si-2', delivery_order_id: null, so_doc_no: DOC, status: 'POSTED', company_id: 1 });
    const res = await reprice('line-bed', { unitPriceSen: 250000, discountSen: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_invoiced');
  });

  test('a line no DO carries is sent back to the normal Edit', async () => {
    const res = await reprice('line-new', { unitPriceSen: 5000, discountSen: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('after_do_price_not_on_do');
  });

  test('a discount above qty x unit price is refused', async () => {
    const res = await reprice('line-bed', { unitPriceSen: 1000, discountSen: 1001 });
    expect(res.status).toBe(422);
    expect(soLine('line-bed').discount_sen).toBe(0);
  });

  test('a negative or fractional price is refused', async () => {
    expect((await reprice('line-bed', { unitPriceSen: -1, discountSen: 0 })).status).toBe(400);
    expect((await reprice('line-bed', { unitPriceSen: 10.5, discountSen: 0 })).status).toBe(400);
  });
});
