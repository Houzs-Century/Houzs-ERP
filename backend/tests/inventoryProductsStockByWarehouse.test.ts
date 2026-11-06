import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { productTotalsHandler } from '../src/scm/routes/inventory';

/* HC-0206 (Sim): with "All warehouses" the Balances row summed every location
   into one Stock figure, so finding WHERE a SKU sits meant picking each
   warehouse in turn. GET /inventory/products now carries `stock_by_warehouse`:
   on-hand per warehouse from the same open lots as Stock + Consignment. */

class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; }
  filter() { return this; }
  not() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return Promise.resolve({ data: out, error: null as null }).then(res, rej);
  }
}

const lot = (warehouse_id: string, qty: number, extra: Record<string, unknown> = {}) => ({
  item_code: 'MATT-K', warehouse_id, received_at: '2026-08-01', qty_remaining: qty,
  remaining_value_sen: qty * 100, source_doc_type: 'GRN', source_doc_no: 'GRN-1', ...extra,
});

const data: Record<string, Array<Record<string, unknown>>> = {
  v_inventory_product_totals: [{ item_code: 'MATT-K', product_name: 'Coolsilk King', category: 'MATTRESS', total_qty: 7 }],
  v_inventory_lots_open: [
    lot('wh-kl', 2), lot('wh-kl', 1),
    lot('wh-pg', 1),
    lot('wh-pj', 3, { source_doc_type: 'PC_RECEIVE', source_doc_no: 'PCR-1' }),
    lot('wh-jb', 0),
  ],
  warehouses: [
    { id: 'wh-kl', code: 'KL', name: 'KL Main' },
    { id: 'wh-pg', code: 'PG', name: 'Penang' },
    { id: 'wh-pj', code: 'PJSR', name: 'PJ Showroom' },
    { id: 'wh-jb', code: 'JB', name: 'Johor' },
  ],
};

async function getRow(query = '') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery(data[t] ?? []) } as never);
    await next();
  });
  app.get('/', productTotalsHandler as never);
  const res = await app.request(`/${query}`);
  const body = (await res.json()) as { products: Array<Record<string, unknown>> };
  return body.products[0] as {
    total_qty: number; owned_qty: number; held_qty: number;
    stock_by_warehouse: Array<{ warehouse_id: string; code: string; name: string | null; qty: number; held_qty: number }>;
  };
}

describe('GET /inventory/products — stock_by_warehouse says where the stock sits (HC-0206)', () => {
  test('one entry per warehouse holding stock, largest first, consignment marked', async () => {
    const r = await getRow();
    expect(r.stock_by_warehouse).toEqual([
      { warehouse_id: 'wh-kl', code: 'KL', name: 'KL Main', qty: 3, held_qty: 0 },
      { warehouse_id: 'wh-pj', code: 'PJSR', name: 'PJ Showroom', qty: 3, held_qty: 3 },
      { warehouse_id: 'wh-pg', code: 'PG', name: 'Penang', qty: 1, held_qty: 0 },
    ]);
  });

  test('the split adds up to the row Stock + Consignment', async () => {
    const r = await getRow();
    expect(r.stock_by_warehouse.reduce((n, w) => n + w.qty, 0)).toBe(r.owned_qty + r.held_qty);
  });

  test('a single-warehouse view lists only that warehouse', async () => {
    const r = await getRow('?warehouseId=wh-pg');
    expect(r.stock_by_warehouse.map((w) => w.code)).toEqual(['PG']);
  });
});
