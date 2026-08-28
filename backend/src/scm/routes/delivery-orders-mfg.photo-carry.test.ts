// Owner 2026-08-10 rule, DO leg (mig 20260828T0746): converting a Sales Order
// into a Delivery Order must carry the SO line's photos onto the DO line —
// 送货时照片要跟着 line; the driver and the customer see the same reference shot
// the salesperson attached. Same contract migration 0274 gave the SO->PO
// convert, pinned by mfg-purchase-orders.photo-carry.test.ts, whose harness
// this copies.
//
// These drive the REAL /from-sos handler (createDoFromSoLinesHandler, the
// exported convert core) through a minimal fake PostgREST client, and assert on
// the rows it hands to delivery_order_items. scm rides Supabase Postgres, so
// this harness cannot run the route itself.
//
// What each test protects, and why it is not obvious from reading the handler:
//   1. the carry happens at all (the field was simply absent before the
//      migration);
//   2. it is PER LINE and never deduplicated — one sofa build is many
//      compartment lines sharing one build photo, and folding them would blank
//      every compartment but the first;
//   3. a photo-less SO line yields [] and never null — delivery_order_items
//      .photo_urls is NOT NULL, so a null here is a failed insert in production.
//
// asDraft: true throughout — a DRAFT DO inserts its lines identically (the
// carry under test) while skipping the stock OUT, the SO-delivered sync and the
// customer email, none of which this fake models.
import { describe, expect, test } from 'vitest';
import { createDoFromSoLinesHandler } from './delivery-orders-mfg';

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
          if (table === 'delivery_order_items') captured.push(...rows);
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

const SO_DOC = 'SO-2608-101';

/** One SO line as the convert reads it. `photos` is the whole point. */
const soLine = (id: string, itemCode: string, photos: string[] | null): Row => ({
  id,
  doc_no: SO_DOC,
  company_id: 1,
  item_code: itemCode,
  item_group: 'MATTRESS',
  description: `${itemCode} description`,
  description2: null,
  uom: 'UNIT',
  qty: 1,
  unit_price_sen: 100000,
  unit_cost_sen: 60000,
  discount_sen: 0,
  variants: {},
  cancelled: false,
  warehouse_id: null,
  photo_urls: photos,
  debtor_code: 'C001',
  debtor_name: 'Customer One',
});

/** Runs the real /from-sos convert over the given SO lines; returns the
 *  captured delivery_order_items rows. */
async function convertAndCapture(soLines: Row[]): Promise<Row[]> {
  const captured: Row[] = [];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    // CONFIRMED — anything else is refused by firstUndeliverableSo before the map.
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

  const responses: Array<{ status: number; body: Record<string, unknown> }> = [];
  const ctx = {
    req: {
      json: async () => ({
        picks: soLines.map((l) => ({ soItemId: l.id, qty: 1 })),
        asDraft: true,
        confirmShortStock: true,
      }),
      param: () => undefined,
    },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      if (key === 'houzsUser') return { id: 7, name: 'Harness' };
      // companyId / allowedCompanyIds / companies stay undefined — the company
      // resolves from the picked rows' own company_id (the handler's contract).
      return undefined;
    },
    env: {},
    json: (body: unknown, status = 200) => {
      const out = { status, body: body as Record<string, unknown> };
      responses.push(out);
      return out;
    },
  } as unknown as Parameters<typeof createDoFromSoLinesHandler>[0];

  const out = (await createDoFromSoLinesHandler(ctx)) as unknown as { status: number; body: Record<string, unknown> };
  if (out.status !== 201) {
    throw new Error(`convert refused: ${out.status} ${JSON.stringify(out.body)}`);
  }
  return captured;
}

describe('SO -> DO convert carries the line photos (mig 20260828T0746)', () => {
  test('a converted DO line carries the source SO line photo keys', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'MATT-A', ['so-items/SO-2608-101/si-1/aaa.jpg']),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.photo_urls).toEqual(['so-items/SO-2608-101/si-1/aaa.jpg']);
    // The provenance link the photo authorisation (and coverage math) keys off.
    expect(rows[0]!.so_item_id).toBe('si-1');
  });

  test('every compartment line of one sofa build keeps the shared build photo', async () => {
    /* The trap this pins: an AutoCount-style sofa build is several compartment
       lines carrying the SAME photo. Deduplicating photos across the DO would
       leave every compartment but one with no photo at all — the driver sees a
       blank line for goods that are on the lorry. (item_group stays MATTRESS so
       the dye-lot batch guard — a different rule — stays out of the frame.) */
    const shared = 'so-items/SO-2608-101/si-1/build.jpg';
    const rows = await convertAndCapture([
      soLine('si-1', 'SOFA-A-LHF', [shared]),
      soLine('si-2', 'SOFA-A-NA', [shared]),
      soLine('si-3', 'SOFA-A-RHF', [shared]),
    ]);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.photo_urls).toEqual([shared]);
  });

  test('several photos on one line all ride across, in order', async () => {
    const keys = [
      'so-items/SO-2608-101/si-1/swatch.jpg',
      'so-items/SO-2608-101/si-1/sketch.png',
    ];
    const rows = await convertAndCapture([soLine('si-1', 'MATT-A', keys)]);
    expect(rows[0]!.photo_urls).toEqual(keys);
  });

  test('a photo-less SO line yields [] and never null (the column is NOT NULL)', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'MATT-A', []),
      soLine('si-2', 'MATT-B', null),
    ]);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.photo_urls).toEqual([]);
  });

  test('photos travel per line — a line with none stays empty beside one with photos', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'MATT-A', ['so-items/SO-2608-101/si-1/aaa.jpg']),
      soLine('si-2', 'MATT-B', null),
    ]);
    const bySoItem = new Map(rows.map((r) => [r.so_item_id, r.photo_urls]));
    expect(bySoItem.get('si-1')).toEqual(['so-items/SO-2608-101/si-1/aaa.jpg']);
    expect(bySoItem.get('si-2')).toEqual([]);
  });
});
