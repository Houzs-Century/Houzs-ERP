import { describe, expect, test } from 'vitest';
import { createDoFromSoLinesHandler } from './delivery-orders-mfg';

type Row = Record<string, unknown>;

function fakeSb(tables: Record<string, Row[]>, captured: Row[]) {
  let minted = 0;
  const mk = (table: string) => {
    const state = { rows: [...(tables[table] ?? [])], single: false };
    const q: Record<string | symbol, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the chainable PostgREST fake has no static shape by design
    const proxy: any = new Proxy(q, {
      get(_t, prop) {
        if (prop === 'then') {
          const result = state.single
            ? { data: state.rows[0] ?? null, error: null, count: state.rows.length }
            : { data: state.rows, error: null, count: state.rows.length };
          return (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            Promise.resolve(result).then(onF, onR);
        }
        if (prop === 'eq') return (col: string, val: unknown) => { state.rows = state.rows.filter((r) => r[col] === val); return proxy; };
        if (prop === 'in') return (col: string, vals: unknown[]) => { state.rows = state.rows.filter((r) => vals.includes(r[col])); return proxy; };
        if (prop === 'is') return (col: string, val: unknown) => { if (val === null) state.rows = state.rows.filter((r) => r[col] == null); return proxy; };
        if (prop === 'range') return (from: number, to: number) => { state.rows = state.rows.slice(from, to + 1); return proxy; };
        if (prop === 'limit') return (n: number) => { state.rows = state.rows.slice(0, n); return proxy; };
        if (prop === 'maybeSingle' || prop === 'single') return () => { state.single = true; return proxy; };
        if (prop === 'insert') return (payload: Row | Row[]) => {
          const rows = Array.isArray(payload) ? payload : [payload];
          if (table === 'delivery_order_items') captured.push(...rows);
          state.rows = table === 'delivery_orders'
            ? rows.map((r) => ({ ...r, id: `do-new-${++minted}` }))
            : rows;
          return proxy;
        };
        return (..._args: unknown[]) => proxy;
      },
    });
    return proxy;
  };
  return {
    from: (table: string) => mk(table),
    rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in this harness' } }),
  };
}

const SO_DOC = 'SO-2611-201';

const soLine = (id: string, qty: number, unitPriceSen: number, discountSen: number): Row => ({
  id,
  doc_no: SO_DOC,
  company_id: 1,
  item_code: `MATT-${id}`,
  item_group: 'MATTRESS',
  description: 'Mattress',
  description2: null,
  uom: 'UNIT',
  qty,
  unit_price_sen: unitPriceSen,
  unit_cost_sen: 0,
  discount_sen: discountSen,
  variants: {},
  cancelled: false,
  warehouse_id: null,
  photo_urls: [],
  debtor_code: 'C001',
  debtor_name: 'Customer One',
});

async function convertAndCapture(soLines: Row[], pickQty: Record<string, number>): Promise<Row[]> {
  const captured: Row[] = [];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    mfg_sales_orders: [{
      doc_no: SO_DOC, company_id: 1, status: 'CONFIRMED', on_hold: false,
      debtor_code: 'C001', debtor_name: 'Customer One',
    }],
    delivery_orders: [],
    delivery_order_items: [],
    delivery_return_items: [],
    delivery_returns: [],
    warehouses: [],
    mfg_products: [],
    purchase_orders: [],
    purchase_order_items: [],
  }, captured);
  const ctx = {
    req: {
      json: async () => ({
        picks: soLines.map((l) => ({ soItemId: l.id, qty: pickQty[l.id as string] })),
        asDraft: true,
        confirmShortStock: true,
        confirmNotReady: true,
      }),
      param: () => undefined,
    },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      if (key === 'houzsUser') return { id: 7, name: 'Harness' };
      return undefined;
    },
    env: {},
    json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
  } as unknown as Parameters<typeof createDoFromSoLinesHandler>[0];
  const out = (await createDoFromSoLinesHandler(ctx)) as unknown as { status: number; body: Record<string, unknown> };
  if (out.status !== 201) throw new Error(`convert refused: ${out.status} ${JSON.stringify(out.body)}`);
  return captured;
}

describe('SO -> DO convert splits the line discount by delivered qty', () => {
  test('delivering 2 of 4 units with RM100 off carries RM50 of the discount, not RM100', async () => {
    const rows = await convertAndCapture([soLine('si-1', 4, 50000, 10000)], { 'si-1': 2 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(2);
    expect(rows[0]!.discount_sen).toBe(5000);
    expect(rows[0]!.line_total_sen).toBe(2 * 50000 - 5000);
  });

  test('delivering the whole line carries the whole discount', async () => {
    const rows = await convertAndCapture([soLine('si-1', 4, 50000, 10000)], { 'si-1': 4 });
    expect(rows[0]!.discount_sen).toBe(10000);
    expect(rows[0]!.line_total_sen).toBe(4 * 50000 - 10000);
  });

  test('1 of 3 units with an odd discount gets the rounded share in whole sen', async () => {
    const rows = await convertAndCapture([soLine('si-1', 3, 10000, 1000)], { 'si-1': 1 });
    expect(rows[0]!.discount_sen).toBe(333);
  });
});
