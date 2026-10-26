import { describe, expect, test } from 'vitest';
import { computeMrp } from './mrp';
import { NO_BUFFERS } from '../lib/lead-time';
import { parsePgrestInList } from '../lib/pgrest-in-list';

type Row = Record<string, unknown>;
type SbArg = Parameters<typeof computeMrp>[0];

function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    private window: [number, number] | null = null;
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => vals.includes(r[col])); return this; }
    filter(col: string, _op: string, val: string) { return this.in(col, parsePgrestInList(val)); }
    not() { return this; }
    is(col: string, val: unknown) { this.rows = this.rows.filter((r) => (r[col] ?? null) === val); return this; }
    gt(col: string, val: number) { this.rows = this.rows.filter((r) => Number(r[col] ?? 0) > val); return this; }
    order() { return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    then<T>(onF: (v: { data: Row[]; error: null }) => T, onR?: (e: unknown) => T) {
      const data = this.window ? this.rows.slice(this.window[0], this.window[1] + 1) : this.rows;
      return Promise.resolve({ data, error: null as null }).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}
const asSb = (fake: unknown): SbArg => fake as SbArg;

const BASE_TABLES: Record<string, Row[]> = {
  mfg_sales_order_items: [], purchase_order_items: [], inventory_balances: [], mfg_products: [],
  warehouses: [], state_warehouse_mappings: [], supplier_material_bindings: [], suppliers: [],
  mrp_category_lead_times: [], fabric_trackings: [], delivery_order_items: [], delivery_return_items: [],
  v_inventory_lots_open: [],
};
const opts = { catFilter: null, whFilter: null, includeUndated: true, companyId: null, leadBuffers: NO_BUFFERS };

/* 2990-0019 (Sim, 2026-10-26). 2990-PO-2610-059 was raised from SO-2610-049
   (XAMMAR + SQUARE PILLOW EZ-002) and 2990-PO-2610-062 from SO-2610-048. The
   pooled walk gave 059's pillow to SO-2610-046 (same fabric, same 11-24
   delivery, smaller doc no) and 062's to 049, so 046 could not order its own
   pillow with its DORSETTLOFT sofa and 048 read SHORT with its PO open. */
describe('company 2: a Sofa Accessory line takes its own purchase order before the pool', () => {
  const co2 = { ...opts, companyId: 2 };
  const EZ2 = { fabricCode: 'EZ-002' };
  const pillow = (id: string, docNo: string, due: string, variants: Row = EZ2): Row => ({
    id, doc_no: docNo, item_code: 'SQUARE PILLOW', description: 'SQUARE PILLOW', item_group: 'fabric_accessory',
    variants, qty: 1, warehouse_id: 'W1', line_delivery_date: due, line_no: 3,
    created_at: '2026-10-24T00:00:00Z', cancelled: false,
    so: { debtor_name: docNo, status: 'CONFIRMED', so_date: '2026-10-24', customer_delivery_date: due, processing_date: '2026-10-24', customer_state: null },
  });
  const pillowPo = (poNumber: string, qty: number, received: number, soItemId: string | null, eta: string, variants: Row = EZ2): Row => ({
    item_code: 'SQUARE PILLOW', item_group: 'fabric_accessory', variants, qty, received_qty: received,
    delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    warehouse_id: 'W1', so_item_id: soItemId,
    po: {
      po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
      supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
      purchase_location_id: 'W1', supplier_id: null,
    },
  });
  const world = (tables: Record<string, Row[]>) => fakeSb({
    ...BASE_TABLES,
    warehouses: [{ id: 'W1', code: 'W1', name: 'KL', is_active: true, company_id: 2 }],
    ...Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.map((r) => ({ ...r, company_id: 2 }))])),
  });
  const run = (tables: Record<string, Row[]>) => computeMrp(asSb(world(tables)), co2);
  const lineOf = (res: Awaited<ReturnType<typeof computeMrp>>, id: string) =>
    res.skus.flatMap((s) => s.lines).find((l) => l.soItemId === id)!;

  const demand = [
    pillow('l-046', '2990-SO-2610-046', '2026-11-24'),
    pillow('l-049', '2990-SO-2610-049', '2026-11-24'),
    pillow('l-048', '2990-SO-2610-048', '2026-12-05'),
    pillow('l-053', '2990-SO-2610-053', '2027-01-07'),
  ];
  const supply = [
    pillowPo('2990-PO-2610-059', 1, 0, 'l-049', '2026-11-17'),
    pillowPo('2990-PO-2610-062', 1, 0, 'l-048', '2026-11-28'),
  ];

  test('each pillow PO covers the SO it was raised from; 046 has none and is SHORT', async () => {
    const res = await run({ mfg_sales_order_items: demand, purchase_order_items: supply });
    expect(lineOf(res, 'l-046').poNumber).toBeNull();
    expect(lineOf(res, 'l-046').shortageQty).toBe(1);
    expect(lineOf(res, 'l-049').poNumber).toBe('2990-PO-2610-059');
    expect(lineOf(res, 'l-048').poNumber).toBe('2990-PO-2610-062');
    expect(lineOf(res, 'l-053').shortageQty).toBe(1);
  });

  test('the SKU row still counts the linked units as PO Outstanding', async () => {
    const res = await run({ mfg_sales_order_items: demand, purchase_order_items: supply });
    const sku = res.skus.find((s) => s.itemCode === 'SQUARE PILLOW')!;
    expect(sku.poOutstanding).toBe(2);
    expect(sku.shortage).toBe(2);
  });

  test('units a linked PO carries beyond its line go back to the pool', async () => {
    const res = await run({ mfg_sales_order_items: demand, purchase_order_items: [pillowPo('2990-PO-2610-059', 2, 0, 'l-049', '2026-11-17')] });
    expect(lineOf(res, 'l-049').poNumber).toBe('2990-PO-2610-059');
    expect(lineOf(res, 'l-046').poNumber).toBe('2990-PO-2610-059');
    expect(lineOf(res, 'l-048').shortageQty).toBe(1);
  });

  test('its own received units are held for it, not handed to the earlier order', async () => {
    const res = await run({
      mfg_sales_order_items: demand,
      purchase_order_items: [pillowPo('2990-PO-2610-059', 1, 1, 'l-049', '2026-11-17')],
      inventory_balances: [{ item_code: 'SQUARE PILLOW', warehouse_id: 'W1', variant_key: 'fabriccode=ez-002', qty: 1 }],
    });
    expect(lineOf(res, 'l-049').stockQty).toBe(1);
    expect(lineOf(res, 'l-049').shortageQty).toBe(0);
    expect(lineOf(res, 'l-046').stockQty).toBe(0);
    expect(lineOf(res, 'l-046').shortageQty).toBe(1);
  });

  test('a link into another fabric\'s bucket stays pooled supply for its own bucket', async () => {
    const res = await run({
      mfg_sales_order_items: [...demand, pillow('l-x', '2990-SO-2610-001', '2026-11-01', { fabricCode: 'EZ-001' })],
      purchase_order_items: [pillowPo('2990-PO-X', 1, 0, 'l-049', '2026-11-10', { fabricCode: 'EZ-001' })],
    });
    expect(lineOf(res, 'l-x').poNumber).toBe('2990-PO-X');
    expect(lineOf(res, 'l-049').poNumber).toBeNull();
  });

  test('an unlinked pillow PO still pools by delivery date', async () => {
    const res = await run({ mfg_sales_order_items: demand, purchase_order_items: [pillowPo('2990-PO-FREE', 1, 0, null, '2026-11-17')] });
    expect(lineOf(res, 'l-046').poNumber).toBe('2990-PO-FREE');
    expect(lineOf(res, 'l-049').shortageQty).toBe(1);
  });
});

