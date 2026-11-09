/* B6 (Conts #790): two "Proceed PO" presses on the SAME MRP plan, driven through
 * convertSosToPosCore. An MRP convert skips the per-line qty cap on a pooled
 * line, so without the freshness check the second press raises a second PO for
 * the same goods. With it, the second press is refused with mrp_plan_stale and
 * a press on a plan computed after the first PO goes through.
 *
 * The fake stamps created_at on insert from a clock the test moves, standing in
 * for the column's now() default, and resolves the po:purchase_orders join the
 * freshness read uses.
 */
import { describe, expect, test } from 'vitest';
import { convertSosToPosCore } from '../src/scm/routes/mfg-purchase-orders';
import { parsePgrestInList } from '../src/scm/lib/pgrest-in-list';

type Row = Record<string, any>;
const CO = 1;

let clock = Date.parse('2026-11-09T02:00:00.000Z');
const tick = (ms: number) => { clock += ms; return new Date(clock).toISOString(); };
let seq = 0;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private tables: Record<string, Row[]>, private table: string) {}
  private get rows() { return (this.tables[this.table] ||= []); }
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.inserted = (Array.isArray(p) ? p : [p]).map((r) => ({
      id: `${this.table}-${++seq}`, created_at: new Date(clock).toISOString(), ...r,
    }));
    return this;
  }
  upsert(p: Row | Row[]) { return this.insert(p); }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  filter(col: string, op: string, val: string) {
    if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
    return this.in(col, parsePgrestInList(val));
  }
  gt(col: string, val: string) { this.preds.push((r) => r[col] != null && String(r[col]) > val); return this; }
  gte() { return this; }
  lte() { return this; }
  lt() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    if (this.table === 'purchase_order_items') {
      const pos = this.tables.purchase_orders ?? [];
      return hit.map((r) => ({ ...r, po: pos.find((p) => p.id === r.purchase_order_id) ?? null }));
    }
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

const seed = (): Record<string, Row[]> => ({
  mfg_sales_order_items: [{
    id: 'soi-1', doc_no: 'HC-SO-2611-001', company_id: CO, item_code: 'MAT-Q', description: 'Queen mattress',
    item_group: 'mattress', variants: null, qty: 2, po_qty_picked: 0, unit_price_sen: 100000,
    line_delivery_date: '2026-12-01', warehouse_id: 'wh-1', photo_urls: null, cancelled: false,
    so: { sales_location: null, customer_delivery_date: '2026-12-01' },
  }],
  supplier_material_bindings: [{
    item_code: 'MAT-Q', supplier_id: 'sup-1', supplier_sku: 'S-MAT-Q', unit_price_sen: 50000, currency: 'MYR',
    price_matrix: null, is_main_supplier: true, material_kind: 'mfg_product', company_id: CO,
  }],
  suppliers: [{ id: 'sup-1', code: 'SUP1', company_id: CO }],
  purchase_orders: [],
  purchase_order_items: [],
});

const proceed = (tables: Record<string, Row[]>, planAsOf: string | undefined) => {
  const sb = { from: (t: string) => new FakeQuery(tables, t), rpc: async () => ({ data: true, error: null }) };
  const get = (key: string): unknown => ({
    supabase: sb, user: { id: 'u1' }, companyId: CO, companyCode: 'HOUZS',
  } as Record<string, unknown>)[key];
  return convertSosToPosCore({
    req: { json: async () => ({ picks: [{ soItemId: 'soi-1', qty: 2 }], mode: 'combined', fromMrp: true, planAsOf }) },
    get: get as never,
    env: { DB: undefined } as never,
    json: (b, status) => ({ status: status ?? 200, body: b as Record<string, unknown> }),
  });
};

describe('MRP Proceed PO on a stale plan (B6)', () => {
  test('without a plan timestamp, a second press on the same lines raises a second PO', async () => {
    /* The pre-fix behaviour, still reachable by a caller that sends no planAsOf:
       nothing on the server stops the duplicate. This is what the page did. */
    const t = seed();
    const first = await proceed(t, undefined);
    expect(first.status).toBe(201);
    tick(60_000);
    const second = await proceed(t, undefined);
    expect(second.status).toBe(201);
    expect(t.purchase_orders).toHaveLength(2);
    expect(t.purchase_order_items.filter((l) => l.so_item_id === 'soi-1')).toHaveLength(2);
  });

  test('a second press on the plan the first was made from is refused, and no PO is added', async () => {
    const t = seed();
    const planAsOf = tick(0);
    tick(5_000);
    const first = await proceed(t, planAsOf);
    expect(first.status).toBe(201);
    expect(t.purchase_orders).toHaveLength(1);

    tick(60_000);
    const second = await proceed(t, planAsOf);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('mrp_plan_stale');
    expect(second.body.soItemIds).toEqual(['soi-1']);
    expect(t.purchase_orders).toHaveLength(1);
    expect(t.purchase_order_items).toHaveLength(1);
  });

  test('a press on a plan recalculated after the first PO goes through', async () => {
    const t = seed();
    const first = await proceed(t, tick(0));
    expect(first.status).toBe(201);
    const regenerated = tick(60_000);
    tick(1_000);
    const second = await proceed(t, regenerated);
    expect(second.status).toBe(201);
    expect(t.purchase_orders).toHaveLength(2);
  });

  test('a PO that is not supply (cancelled) does not make the plan stale', async () => {
    const t = seed();
    const planAsOf = tick(0);
    tick(5_000);
    expect((await proceed(t, planAsOf)).status).toBe(201);
    t.purchase_orders[0].status = 'CANCELLED';
    tick(60_000);
    expect((await proceed(t, planAsOf)).status).toBe(201);
  });
});
