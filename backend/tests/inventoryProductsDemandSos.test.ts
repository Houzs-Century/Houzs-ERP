import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { productTotalsHandler } from '../src/scm/routes/inventory';

/* HC-0115 (Sim): the Balances row showed "Unscheduled 13" for a mattress with no
   way to see WHICH Sales Orders make up the 13. GET /inventory/products now
   carries `demand_sos` per SKU: the open SO lines behind Scheduled and
   Unscheduled, net of delivered, so the row expansion can list them. The list
   must add up to exactly the two figures it explains. */

class FakeQuery {
  private preds: Array<(r: Record<string, unknown>) => boolean> = [];
  private _range: [number, number] | null = null;
  constructor(private rows: Array<Record<string, unknown>>) {}
  select() { return this; }
  order() { return this; }
  or() { return this; }
  filter() { return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set(vals.map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  /* The demand read pre-filters finished orders on the !inner `so` embed
     (`so.status` not in SO_DONE); modelled so line 'e' is dropped by the read
     as in PostgREST, with the handler's own SO_DONE filter still behind it. */
  not(col: string, op: string, list: string) {
    if (op !== 'in') return this;
    const s = new Set([...list.matchAll(/"([^"]*)"/g)].map((m) => m[1]));
    const [head, field] = col.split('.');
    this.preds.push((r) => !s.has(String(field ? (r[head] as Record<string, unknown> | null)?.[field] : r[col])));
    return this;
  }
  range(from: number, to: number) { this._range = [from, to]; return this; }
  then(res: (v: { data: unknown[]; error: null }) => unknown, rej?: (e: unknown) => unknown) {
    let out = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    return Promise.resolve({ data: out, error: null as null }).then(res, rej);
  }
}

const so = (status: string, debtor: string, soDate: string, delivery: string | null) =>
  ({ status, customer_delivery_date: delivery, debtor_name: debtor, so_date: soDate });

const line = (id: string, doc: string, qty: number, head: ReturnType<typeof so>, extra: Record<string, unknown> = {}) =>
  ({ id, doc_no: doc, item_code: 'MATT-K', qty, warehouse_id: 'wh1', line_delivery_date: null, cancelled: false, so: head, ...extra });

const data: Record<string, Array<Record<string, unknown>>> = {
  v_inventory_product_totals: [{ item_code: 'MATT-K', product_name: 'Coolsilk King', category: 'MATTRESS', total_qty: 10 }],
  mfg_sales_order_items: [
    line('a', 'SO-001', 4, so('CONFIRMED', 'Ali', '2026-08-01', null)),
    line('b', 'SO-002', 6, so('CONFIRMED', 'Bala', '2026-08-04', null)),
    line('b2', 'SO-002', 1, so('CONFIRMED', 'Bala', '2026-08-04', null)),
    // Partly delivered: 5 ordered, 3 shipped -> 2 still claimed.
    line('c', 'SO-003', 5, so('CONFIRMED', 'Chong', '2026-07-20', null)),
    // Line-level date makes it Scheduled even though the header has none.
    line('d', 'SO-004', 2, so('CONFIRMED', 'Devi', '2026-08-02', null), { line_delivery_date: '2026-10-20' }),
    // Not demand: done SO, cancelled line.
    line('e', 'SO-005', 9, so('DELIVERED', 'Eng', '2026-06-01', null)),
    line('f', 'SO-006', 9, so('CONFIRMED', 'Fong', '2026-08-03', null), { cancelled: true }),
  ],
  delivery_order_items: [{ id: 'doi1', so_item_id: 'c', qty: 3, delivery_order_id: 'do1' }],
  delivery_orders: [{ id: 'do1', status: 'DELIVERED' }],
};

async function getRow() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, { from: (t: string) => new FakeQuery(data[t] ?? []) } as never);
    await next();
  });
  app.get('/', productTotalsHandler as never);
  const res = await app.request('/');
  const body = (await res.json()) as { products: Array<Record<string, unknown>> };
  return body.products[0] as {
    unscheduled_qty: number; committed_scheduled: number;
    demand_sos: Array<{ doc_no: string; debtor_name: string | null; so_date: string | null; delivery_date: string | null; qty: number }>;
  };
}

describe('GET /inventory/products — demand_sos names the SOs behind Scheduled / Unscheduled (HC-0115)', () => {
  test('lists each open SO once, net of delivered, scheduled first then unscheduled oldest SO first', async () => {
    const r = await getRow();
    expect(r.demand_sos).toEqual([
      { doc_no: 'SO-004', debtor_name: 'Devi', so_date: '2026-08-02', delivery_date: '2026-10-20', qty: 2 },
      { doc_no: 'SO-003', debtor_name: 'Chong', so_date: '2026-07-20', delivery_date: null, qty: 2 },
      { doc_no: 'SO-001', debtor_name: 'Ali', so_date: '2026-08-01', delivery_date: null, qty: 4 },
      { doc_no: 'SO-002', debtor_name: 'Bala', so_date: '2026-08-04', delivery_date: null, qty: 7 },
    ]);
  });

  test('the listed SOs add up to the Unscheduled and Scheduled figures', async () => {
    const r = await getRow();
    const sum = (scheduled: boolean) => r.demand_sos
      .filter((s) => (s.delivery_date !== null) === scheduled)
      .reduce((n, s) => n + s.qty, 0);
    expect(r.unscheduled_qty).toBe(13);
    expect(sum(false)).toBe(r.unscheduled_qty);
    expect(sum(true)).toBe(r.committed_scheduled);
  });
});
