// Regression (sister fix Conts-ERP #746): a delivery order never recorded the
// warehouse it ships from, so the DO page showed the SO's sales-location text
// as "Warehouse" and a free line added later drew stock from the company
// default. Drives the REAL /from-sos handler through the fake PostgREST client
// of delivery-orders-mfg.photo-carry.test.ts and asserts on the DO HEADER row.
import { describe, expect, test } from 'vitest';
import { createDoFromSoLinesHandler } from './delivery-orders-mfg';
import { doShipFromWarehouseId } from '../lib/do-line-warehouses';

type Row = Record<string, unknown>;

/* Captures every row written to delivery_order_items, which is what these
   assertions are about. Reads are served from `tables`; writes to anything else
   (the audit row, the AutoCount skip record, the totals rollup) are accepted
   and ignored so the convert can run to completion without the fake modelling
   the whole schema. A Proxy, unlike the PO harness's fixed method list, because
   this handler's read surface is far wider (remaining derivation, warehouse
   resolution, sofa guards, doc-no minting) — any unmodelled chained method
   filters nothing and resolves to the current row set. */
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
          if (table === 'delivery_orders') captured.push(...rows);
          /* The DO header insert is chained `.select('id, do_number').single()`,
             so hand back a row carrying the id the line insert keys off. */
          state.rows = table === 'delivery_orders'
            ? rows.map((r) => ({ ...r, id: `do-new-${++minted}` }))
            : rows;
          return proxy;
        };
        // select / order / like / not / or / gte / lte / update / delete / …
        // — chainable no-ops over the current row set.
        return (..._args: unknown[]) => proxy;
      },
    });
    return proxy;
  };
  return {
    from: (table: string) => mk(table),
    /* The doc-no counter RPC — report it MISSING (PGRST202, the shape
       isMissingRpc recognises) so minting falls back to the live-max path,
       which needs only the (empty) delivery_orders table. */
    rpc: () => Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function in this harness' } }),
  };
}

const SO_DOC = 'SO-2611-301';

const soLine = (id: string, warehouseId: string | null): Row => ({
  id, doc_no: SO_DOC, company_id: 1, item_code: `MATT-${id}`, item_group: 'MATTRESS',
  description: 'Mattress', description2: null, uom: 'UNIT', qty: 1,
  unit_price_sen: 10000, unit_cost_sen: 0, discount_sen: 0, variants: {},
  cancelled: false, warehouse_id: warehouseId, photo_urls: [],
  debtor_code: 'C001', debtor_name: 'Customer One',
});

async function convertHeader(soLines: Row[], warehouses: Row[] = []): Promise<Row> {
  const captured: Row[] = [];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    mfg_sales_orders: [{ doc_no: SO_DOC, company_id: 1, status: 'CONFIRMED', on_hold: false, debtor_code: 'C001', debtor_name: 'Customer One' }],
    delivery_orders: [], delivery_order_items: [], delivery_return_items: [], delivery_returns: [],
    warehouses, mfg_products: [], purchase_orders: [], purchase_order_items: [],
  }, captured);
  const ctx = {
    req: {
      json: async () => ({ picks: soLines.map((l) => ({ soItemId: l.id, qty: 1 })), asDraft: true, confirmShortStock: true, confirmNotReady: true }),
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
  expect(captured).toHaveLength(1);
  return captured[0]!;
}

describe('SO -> DO convert records the ship-from warehouse on the DO header', () => {
  test('every line from one warehouse: the DO names it', async () => {
    const h = await convertHeader([soLine('si-1', 'wh-kl'), soLine('si-2', 'wh-kl')]);
    expect(h.warehouse_id).toBe('wh-kl');
  });

  test('lines from two warehouses: the DO stays per line (null)', async () => {
    const h = await convertHeader([soLine('si-1', 'wh-kl'), soLine('si-2', 'wh-pg')]);
    expect(h.warehouse_id).toBeNull();
  });
});

describe('doShipFromWarehouseId', () => {
  const m = (...ws: Array<string | null>) => new Map(ws.map((w, i) => [String(i), w]));
  test('the explicit choice wins', () => {
    expect(doShipFromWarehouseId('wh-x', m('wh-kl', 'wh-pg'))).toBe('wh-x');
  });
  test('one shared line warehouse is the answer', () => {
    expect(doShipFromWarehouseId(null, m('wh-kl', 'wh-kl'))).toBe('wh-kl');
  });
  test('several warehouses, an unresolved line, or no lines: null', () => {
    expect(doShipFromWarehouseId(null, m('wh-kl', 'wh-pg'))).toBeNull();
    expect(doShipFromWarehouseId(null, m('wh-kl', null))).toBeNull();
    expect(doShipFromWarehouseId(null, m())).toBeNull();
  });
});
