// Owner 2026-08-10: "Sales Order 里面可以存放照片，PO 那边也可以存放照片。因为当我们将
// Sales Order 转换成 PO 时，那个 PO 也会自动带着这张照片." — converting an SO into a PO
// must carry the SO line's photos onto the PO line.
//
// These drive the REAL convert body (convertSosToPosCore, the same function the
// /from-sos route and the Procurement Agent both call) through a minimal fake
// PostgREST client, and assert on the rows it hands to purchase_order_items.
// Same fake shape as so-converted-po.test.ts / mrp.test.ts — scm rides Supabase
// Postgres, so this harness cannot run the route itself.
//
// What each test protects, and why it is not obvious from reading the handler:
//   1. the carry happens at all (the field was simply absent before migration 0274);
//   2. it is PER LINE and never deduplicated — one sofa build is many compartment
//      lines sharing one build photo, and folding them would blank every
//      compartment but the first;
//   3. a photo-less SO line yields [] and never null — purchase_order_items
//      .photo_urls is NOT NULL, so a null here is a failed insert in production.
import { describe, expect, test } from 'vitest';
import { convertSosToPosCore, type PoConvertContext } from './mfg-purchase-orders';

type Row = Record<string, unknown>;

/* Captures every row written to purchase_order_items, which is what these
   assertions are about. Reads are served from `tables`; writes to anything else
   are accepted and ignored (the audit row, the po_qty_picked recount) so the
   convert can run to completion without the fake modelling the whole schema. */
function fakeSb(tables: Record<string, Row[]>, captured: Row[]) {
  class Q {
    rows: Row[];
    private table: string;
    private singleRow = false;
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    not() { return this; }
    is(col: string, val: unknown) {
      if (val === null) this.rows = this.rows.filter((r) => r[col] == null);
      return this;
    }
    or() { return this; }
    like() { return this; }
    ilike() { return this; }
    gte() { return this; }
    lte() { return this; }
    order() { return this; }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range() { return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    update() { return this; }
    delete() { return this; }
    insert(payload: Row | Row[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      if (this.table === 'purchase_order_items') captured.push(...rows);
      /* The PO header insert is chained `.select(...).single()`, so hand back a
         row carrying the id + po_number the line insert keys off. */
      if (this.table === 'purchase_orders') {
        this.rows = rows.map((r, i) => ({ ...r, id: `po-new-${i + 1}`, po_number: r.po_number ?? 'PO-2608-001' }));
      } else {
        this.rows = rows;
      }
      return this;
    }
    private result() {
      if (this.singleRow) return { data: this.rows[0] ?? null, error: null as null };
      return { data: this.rows, error: null as null };
    }
    then<T>(onF: (v: { data: unknown; error: null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const SUPPLIER_ID = 'sup-1';

/** One SO line as the convert reads it. `photos` is the whole point. */
const soLine = (id: string, itemCode: string, photos: string[] | null): Row => ({
  id,
  doc_no: 'SO-2608-001',
  item_code: itemCode,
  description: `${itemCode} description`,
  item_group: 'SOFA',
  variants: {},
  qty: 1,
  po_qty_picked: 0,
  unit_price_sen: 100000,
  line_delivery_date: '2026-09-30',
  warehouse_id: 'wh-kl',
  photo_urls: photos,
  so: { sales_location: 'KL', customer_delivery_date: '2026-09-30' },
});

/** Runs the real convert over the given SO lines; returns the PO line rows. */
async function convertAndCapture(soLines: Row[]): Promise<Row[]> {
  const captured: Row[] = [];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    // CONFIRMED — anything else is refused by the orderable gate before the map.
    mfg_sales_orders: [{ doc_no: 'SO-2608-001', status: 'CONFIRMED' }],
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
    suppliers: [{ id: SUPPLIER_ID, code: 'SUP1', name: 'Supplier One' }],
    supplier_material_bindings: soLines.map((l) => ({
      material_code: l.item_code,
      material_kind: 'mfg_product',
      supplier_id: SUPPLIER_ID,
      supplier_sku: `SKU-${l.item_code}`,
      unit_price_sen: 50000,
      currency: 'MYR',
      price_matrix: null,
      is_main_supplier: true,
    })),
    fabric_trackings: [],
    mrp_category_lead_times: [],
    sofa_combo_pricing: [],
    purchase_orders: [],
    purchase_order_items: [],
  }, captured);

  const ctx = {
    req: { json: async () => ({ picks: soLines.map((l) => ({ soItemId: l.id, qty: 1 })) }) },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    },
    // loadLeadBuffers swallows a throwing DB and falls back to no buffers, which
    // is the behaviour under test here (dates are not what these assert on).
    env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
    json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
  } as unknown as PoConvertContext;

  const out = await convertSosToPosCore(ctx);
  if (out.status !== 201) {
    throw new Error(`convert refused: ${out.status} ${JSON.stringify(out.body)}`);
  }
  return captured;
}

describe('SO -> PO convert carries the line photos (migration 0274)', () => {
  test('a converted PO line carries the source SO line photo keys', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'SOFA-A', ['so-items/SO-2608-001/si-1/aaa.jpg']),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].photo_urls).toEqual(['so-items/SO-2608-001/si-1/aaa.jpg']);
    // The provenance link is what a later importer keys its own photos off.
    expect(rows[0].so_item_id).toBe('si-1');
  });

  test('every compartment line of one sofa build keeps the shared build photo', async () => {
    /* The trap this pins: an AutoCount-style sofa build is several compartment
       lines carrying the SAME photo. Deduplicating photos across the PO would
       leave every compartment but one with no photo at all — the operator sees
       a blank line and re-attaches by hand. */
    const shared = 'so-items/SO-2608-001/si-1/build.jpg';
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
      'so-items/SO-2608-001/si-1/swatch.jpg',
      'so-items/SO-2608-001/si-1/sketch.png',
    ];
    const rows = await convertAndCapture([soLine('si-1', 'SOFA-A', keys)]);
    expect(rows[0].photo_urls).toEqual(keys);
  });

  test('a photo-less SO line yields [] and never null (the column is NOT NULL)', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'SOFA-A', []),
      soLine('si-2', 'SOFA-B', null),
    ]);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.photo_urls).toEqual([]);
  });

  test('photos travel per line — a line with none stays empty beside one with photos', async () => {
    const rows = await convertAndCapture([
      soLine('si-1', 'SOFA-A', ['so-items/SO-2608-001/si-1/aaa.jpg']),
      soLine('si-2', 'SOFA-B', null),
    ]);
    const bySoItem = new Map(rows.map((r) => [r.so_item_id, r.photo_urls]));
    expect(bySoItem.get('si-1')).toEqual(['so-items/SO-2608-001/si-1/aaa.jpg']);
    expect(bySoItem.get('si-2')).toEqual([]);
  });
});
