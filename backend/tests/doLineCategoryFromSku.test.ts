/* The OUTBOUND half of docs/bugs/0514 — a delivery order must not let the
 * client decide which stock bucket it checks and ships from (docs/bugs/0523).
 *
 * `item_group` is not a label. `computeVariantKey(item_group, variants)`
 * composes a bedframe's fabric / gap / divan / leg into the stock key ONLY when
 * the group says bedframe (or sofa); for `others` or null it returns '' by
 * design. So a bedframe line that reaches the server with a blank or wrong
 * group is measured against the UNCLASSIFIED bucket and, later, deducted from
 * it — while the goods sit in the bedframe bucket, in the same warehouse,
 * invisible. That is exactly the shape that made HC-SO-2608-004 unshippable.
 *
 * PR #2660 fixed the INBOUND documents (PO / SO / GRN / CO). The delivery side
 * still read `it.itemGroup` straight off the request body, so this suite drives
 * the REAL add-line handler with a fake PostgREST and pins BOTH readings of the
 * group in one request:
 *
 *   1. THE CHECK — the short-stock 409 the operator is shown names the
 *      bedframe bucket, not ''.
 *   2. THE WRITE — the row stored carries item_group 'bedframe', which is what
 *      deductInventoryForDo / resyncInventoryForDo key their OUT from. The
 *      check and the deduction therefore cannot disagree: they are the same
 *      resolved value, assigned once.
 *
 * PROVED RED on the unfixed tree (the two assertions above fail with
 * variantKey '' and item_group 'others'). A bedframe is used rather than a sofa
 * on purpose: the sofa dye-lot guard would refuse the add for its own separate
 * reason and hide the assertion this suite exists to make.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { addDeliveryOrderItemHandler } from '../src/scm/routes/delivery-orders-mfg';
import { computeVariantKey } from '../src/scm/shared/variant-key';

const CO = 1;
const WH = 'wh-balakong';
/* The catalogue says BEDFRAME. Every request below says otherwise. */
const CODE = 'BF-KING-01';
const VARIANTS = { fabricColor: 'BF-16', gap: '16', divanHeight: '10', legHeight: '2' };
/* Not typed by hand — the key the SKU's own group produces, from the real rule. */
const BEDFRAME_KEY = computeVariantKey('bedframe', VARIANTS);

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  private head = false;
  constructor(private rows: Row[]) {}
  select(_cols?: unknown, opts?: { head?: boolean; count?: string }) {
    if (opts?.head) this.head = true;
    return this;
  }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => r[col] === val); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => r[col] !== val); return this; }
  in(col: string, vals: unknown[]) { this.preds.push((r) => vals.includes(r[col])); return this; }
  is(col: string, val: unknown) {
    if (val === null) this.preds.push((r) => r[col] === null || r[col] === undefined);
    else this.preds.push((r) => r[col] === val);
    return this;
  }
  gt(col: string, val: number) { this.preds.push((r) => Number(r[col] ?? 0) > val); return this; }
  order() { return this; } limit() { return this; } range() { return this; }
  gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; }
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
    const hit = this.run();
    return Promise.resolve(
      this.head ? { data: null, error: null, count: hit.length } : { data: hit, error: null },
    ).then(res, rej);
  }
}

/* Seeded so the ONLY thing the cases vary is the group the request claims.
   The warehouse holds NOTHING in either bucket, so the check is guaranteed to
   report a shortage — what is under test is WHICH bucket it names. */
function tables(): Record<string, Row[]> {
  return {
    mfg_products: [{ code: CODE, category: 'BEDFRAME', company_id: CO, unit_m3_milli: 0 }],
    warehouses: [{ id: WH, code: 'BLK', name: 'BALAKONG WAREHOUSE', company_id: CO }],
    delivery_orders: [{
      id: 'do-1', do_number: 'HC-DO-2608-001', company_id: CO,
      status: 'LOADED', warehouse_id: WH, so_doc_no: null,
    }],
    delivery_order_items: [],
    inventory_balances: [],
    inventory_movements: [],
    mfg_sales_order_items: [],
    mfg_sales_orders: [],
    delivery_returns: [],
    delivery_return_items: [],
    sales_invoices: [],
    sales_invoice_items: [],
    purchase_order_items: [],
    purchase_orders: [],
    entity_audit_log: [],
  };
}

function harness(t: Record<string, Row[]>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (name: string) => new FakeQuery((t[name] ||= [])),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.post('/delivery-orders/:id/items', addDeliveryOrderItemHandler as never);
  return app;
}

const addLine = (app: Hono, line: Record<string, unknown>) =>
  app.request('/delivery-orders/do-1/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(line),
  });

describe('DO add-line — the stock bucket follows the SKU, not the request', () => {
  test('the shortage shown names the SKU bucket even when the request says `others`', async () => {
    const t = tables();
    const res = await addLine(harness(t), {
      itemCode: CODE, itemGroup: 'others', variants: VARIANTS, qty: 1, unitPriceSen: 100000,
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error?: string; shortages?: Array<{ variantKey: string }> };
    expect(body.error).toBe('short_stock');
    /* THE REGRESSION. Unfixed this is '' — the unclassified bucket — so the
       operator waives a shortage measured against goods that were never there. */
    expect(body.shortages?.[0]?.variantKey).toBe(BEDFRAME_KEY);
    expect(BEDFRAME_KEY).not.toBe('');
  });

  test('a request that sends NO group at all gets the same bucket', async () => {
    const t = tables();
    const res = await addLine(harness(t), {
      itemCode: CODE, variants: VARIANTS, qty: 1, unitPriceSen: 100000,
    });
    const body = await res.json() as { shortages?: Array<{ variantKey: string }> };
    expect(body.shortages?.[0]?.variantKey).toBe(BEDFRAME_KEY);
  });

  test('and the row STORED carries the SKU group, so the OUT deducts from the bucket that was checked', async () => {
    const t = tables();
    const res = await addLine(harness(t), {
      itemCode: CODE, itemGroup: 'others', variants: VARIANTS, qty: 1,
      unitPriceSen: 100000, confirmShortStock: true,
    });
    expect(res.status).toBe(201);
    const stored = t.delivery_order_items.at(-1)!;
    /* deductInventoryForDo / resyncInventoryForDo re-read THIS column and key
       their OUT from computeVariantKey(item_group, variants). Storing the
       resolved group is what makes the check and the deduction one answer. */
    expect(stored.item_group).toBe('bedframe');
    expect(computeVariantKey(stored.item_group, stored.variants)).toBe(BEDFRAME_KEY);
  });

  test('a code the catalogue does not classify keeps whatever the caller sent', async () => {
    const t = tables();
    t.mfg_products.push({ code: 'SPARE-LEG', category: null, company_id: CO });
    const res = await addLine(harness(t), {
      itemCode: 'SPARE-LEG', itemGroup: 'accessory', qty: 1,
      unitPriceSen: 1000, confirmShortStock: true,
    });
    expect(res.status).toBe(201);
    expect(t.delivery_order_items.at(-1)!.item_group).toBe('accessory');
  });
});
