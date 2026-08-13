// Unit tests for computeMrp's legacy-variant coverage math (audit R4).
//
// The MRP coverage engine is FLOATING by design: coverage is recomputed at read
// time, pooled globally across SOs, and evaporates on delivery (owner-confirmed
// intentional — NOT under test here). What IS under test is the legacy '' variant
// double-count: a PO raised BEFORE SO→PO carried variants keys under '' (the
// unclassified bucket). That legacy pool is meant to back-fill a real-variant row
// as a FALLBACK, but the engine used to fold it in ON TOP of the variant's own PO
// supply — so one physical legacy PO line counted its quantity twice (inflating PO
// Outstanding and over-covering demand, hiding a real shortage).
//
// Route-level coverage isn't possible in this harness (scm rides Supabase
// Postgres; the harness rebuilds only the D1 side), so these drive computeMrp
// through a minimal fake PostgREST client — same shape as so-converted-po.test.ts,
// extended with the operators this engine chains (eq / in / order / limit / range).
import { describe, expect, test } from 'vitest';
import { computeMrp, mrpStockAssignment, stockAssignmentKey } from './mrp';
import { NO_BUFFERS } from '../lib/lead-time';
import { distributeAssignedToLots, isMakeToOrderCategory } from '../lib/inventory-movements';

type Row = Record<string, unknown>;

// A fake PostgREST query: chainable filters, awaitable, paginable via range().
function fakeSb(tables: Record<string, Row[]>) {
  class Q {
    rows: Row[];
    private window: [number, number] | null = null;
    constructor(rows: Row[]) { this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { this.rows = this.rows.filter((r) => (vals as unknown[]).includes(r[col])); return this; }
    // No-op: the engine pushes status not-in filters into SQL as an under-the-cap
    // optimisation; the JS-side SO_DONE / PO_DEAD filters stay authoritative and
    // are what these tests exercise.
    not() { return this; }
    // Real slice, so the mrp_load_truncated guard (rows === cap) is testable.
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    order() { return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    private result() {
      const rows = this.window ? this.rows.slice(this.window[0], this.window[1] + 1) : this.rows;
      return { data: rows, error: null as null };
    }
    then<T>(onF: (v: { data: Row[]; error: null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(tables[table] ?? []) };
}

// Empty side-tables every computeMrp run touches — spread first, override per test.
const BASE_TABLES: Record<string, Row[]> = {
  mfg_sales_order_items: [],
  purchase_order_items: [],
  inventory_balances: [],
  mfg_products: [],
  warehouses: [],
  state_warehouse_mappings: [],
  supplier_material_bindings: [],
  suppliers: [],
  mrp_category_lead_times: [],
  fabric_trackings: [],
  delivery_order_items: [],
  delivery_return_items: [],
};

const opts = { catFilter: null, whFilter: null, includeUndated: true, companyId: null, leadBuffers: NO_BUFFERS };

// SO demand line for BF-100 in warehouse W1 with a real fabric variant.
const demandRed = (qty: number): Row => ({
  id: 'si-red', doc_no: 'SO-1', item_code: 'BF-100', description: 'Baron Bedframe',
  item_group: 'bedframe', variants: { fabricCode: 'RED' }, qty,
  warehouse_id: 'W1', line_delivery_date: '2026-12-01', line_no: 1, created_at: '2026-07-01T00:00:00Z',
  cancelled: false,
  so: { debtor_name: 'Acme', status: 'CONFIRMED', so_date: '2026-07-01', customer_delivery_date: '2026-12-01', processing_date: null, customer_state: null },
});

// A PO supply line for BF-100 → W1. `variant` null builds the legacy '' key.
const poLine = (poNumber: string, qty: number, variant: Row | null, eta: string): Row => ({
  material_code: 'BF-100', item_group: 'bedframe', variants: variant ?? {}, qty, received_qty: 0,
  delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  warehouse_id: 'W1', so_item_id: null,
  po: {
    po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    purchase_location_id: 'W1', supplier_id: null,
  },
});

describe('computeMrp — legacy-variant double-count (audit R4)', () => {
  test('a real variant with its own PO does NOT also count the stale "" PO on top', async () => {
    // Demand 8 of RED. Supply: a real RED PO for 5 + a stale legacy '' PO for 5.
    // The legacy PO belongs to nobody here (there is no '' demand) — it must not
    // back the RED row on top of RED's own PO. Correct answer: PO Outstanding 5,
    // shortage 3. (Bug: PO Outstanding 10, shortage 0 — legacy counted twice.)
    const sb = fakeSb({
      mfg_sales_order_items: [demandRed(8)],
      purchase_order_items: [
        poLine('PO-RED', 5, { fabricCode: 'RED' }, '2026-11-01'),
        poLine('PO-LEGACY', 5, null, '2026-10-01'),
      ],
      inventory_balances: [],
      mfg_products: [],
      warehouses: [],
      supplier_material_bindings: [],
      suppliers: [],
      mrp_category_lead_times: [],
      fabric_trackings: [],
      delivery_order_items: [],
      delivery_return_items: [],
    });

    const res = await computeMrp(sb as any, opts);
    expect(res.skus).toHaveLength(1); // no phantom '' row — '' has no demand
    const row = res.skus[0]!;
    expect(row.itemCode).toBe('BF-100');
    expect(row.variantKey).toBe('fabriccode=red');
    expect(row.qtyNeeded).toBe(8);
    expect(row.stock).toBe(0);
    expect(row.poOutstanding).toBe(5); // RED's own PO only — legacy NOT added on top
    expect(row.shortage).toBe(3);      // 8 needed − 5 covered by PO-RED
    expect(res.totals.shortageUnits).toBe(3);
  });

  test('a real variant with NO own PO still draws the legacy "" pool (fallback preserved)', async () => {
    // Demand 5 of RED, no RED PO — only a legacy '' PO for 5. The fallback must
    // still fire so a pre-variant PO covers the variant row (the behaviour the
    // fold-in exists for). Correct answer: covered by PO-LEGACY, shortage 0.
    const sb = fakeSb({
      mfg_sales_order_items: [demandRed(5)],
      purchase_order_items: [poLine('PO-LEGACY', 5, null, '2026-10-01')],
      inventory_balances: [],
      mfg_products: [],
      warehouses: [],
      supplier_material_bindings: [],
      suppliers: [],
      mrp_category_lead_times: [],
      fabric_trackings: [],
      delivery_order_items: [],
      delivery_return_items: [],
    });

    const res = await computeMrp(sb as any, opts);
    expect(res.skus).toHaveLength(1);
    const row = res.skus[0]!;
    expect(row.variantKey).toBe('fabriccode=red');
    expect(row.poOutstanding).toBe(5);
    expect(row.shortage).toBe(0);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]!.source).toBe('po');
    expect(row.lines[0]!.poNumber).toBe('PO-LEGACY');
  });
});

// A stock balance row for BF-100 → W1 with the RED variant key.
const stockRed = (qty: number): Row => ({
  product_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty,
});

describe('mrpStockAssignment — assigned-vs-free split (owner 2026-07-25, dead-stock view)', () => {
  test('10 on hand, 3 allocated to an SO → 3 assigned / 7 free', async () => {
    // Demand 3 of RED, 10 RED in stock, no PO. MRP allocates 3 on-hand units to
    // SO-1; the other 7 are un-assigned (FREE = dead-stock candidate).
    const sb = fakeSb({
      mfg_sales_order_items: [demandRed(3)],
      purchase_order_items: [],
      inventory_balances: [stockRed(10)],
      mfg_products: [{ code: 'BF-100', name: 'Baron Bedframe', category: 'BEDFRAME' }],
      warehouses: [{ id: 'W1', code: 'KL', name: 'KL WAREHOUSE', is_active: true }],
      supplier_material_bindings: [],
      suppliers: [],
      mrp_category_lead_times: [],
      fabric_trackings: [],
      delivery_order_items: [],
      delivery_return_items: [],
    });

    const res = await computeMrp(sb as any, opts);
    const row = res.skus[0]!;
    expect(row.stock).toBe(10);
    expect(row.lines[0]!.source).toBe('stock');
    expect(row.lines[0]!.stockQty).toBe(3); // 3 on-hand units consumed by SO-1

    const asg = mrpStockAssignment(res);
    const key = stockAssignmentKey('W1', 'BF-100', 'fabriccode=red');
    const bucket = asg.get(key)!;
    expect(bucket.assigned).toBe(3);
    expect(bucket.claims).toHaveLength(1);
    expect(bucket.claims[0]).toMatchObject({ soDocNo: 'SO-1', qty: 3 });

    // Spread the assignment across the SKU's ONE open lot of 10 → 3 assigned / 7 free.
    const [lot] = distributeAssignedToLots([10], bucket.assigned, bucket.claims);
    expect(lot!.assignedQty).toBe(3);
    expect(lot!.freeQty).toBe(7);
    expect(lot!.assignedTo).toEqual([{ soDocNo: 'SO-1', deliveryDate: '2026-12-01', qty: 3 }]);
  });

  test('a make-to-order SKU with stock but NO SO demand → all free = dead stock', async () => {
    // 6 RED bedframes on hand, zero open SO demand. MRP builds no bucket for it,
    // so nothing is assigned — every unit is free, and BEDFRAME is make-to-order
    // (abnormal), so the whole lot is a dead-stock candidate.
    const sb = fakeSb({
      mfg_sales_order_items: [],
      purchase_order_items: [],
      inventory_balances: [stockRed(6)],
      mfg_products: [{ code: 'BF-100', name: 'Baron Bedframe', category: 'BEDFRAME' }],
      warehouses: [{ id: 'W1', code: 'KL', name: 'KL WAREHOUSE', is_active: true }],
      supplier_material_bindings: [],
      suppliers: [],
      mrp_category_lead_times: [],
      fabric_trackings: [],
      delivery_order_items: [],
      delivery_return_items: [],
    });

    const res = await computeMrp(sb as any, opts);
    const asg = mrpStockAssignment(res);
    const key = stockAssignmentKey('W1', 'BF-100', 'fabriccode=red');
    expect(asg.get(key)).toBeUndefined(); // no demand → no assignment

    // Endpoint behaviour: absent assignment → all on-hand units free.
    const [lot] = distributeAssignedToLots([6], asg.get(key)?.assigned ?? 0, asg.get(key)?.claims ?? []);
    expect(lot!.assignedQty).toBe(0);
    expect(lot!.freeQty).toBe(6);
    expect(isMakeToOrderCategory('BEDFRAME')).toBe(true); // free stock here is abnormal
    expect(isMakeToOrderCategory('MATTRESS')).toBe(false); // make-to-stock, free is normal
  });
});

describe('distributeAssignedToLots — FIFO spread across multiple lots', () => {
  test('assigns oldest lots first, splitting the boundary lot', () => {
    // Bucket assigned 4 across three FIFO lots [2,3,5]. Oldest 2 fully assigned,
    // 2 more from the second lot (1 free there), the third fully free.
    const claims = [
      { soDocNo: 'SO-A', deliveryDate: '2026-10-01', qty: 3 },
      { soDocNo: 'SO-B', deliveryDate: '2026-11-01', qty: 1 },
    ];
    const out = distributeAssignedToLots([2, 3, 5], 4, claims);
    expect(out[0]).toMatchObject({ assignedQty: 2, freeQty: 0 });
    expect(out[1]).toMatchObject({ assignedQty: 2, freeQty: 1 });
    expect(out[2]).toMatchObject({ assignedQty: 0, freeQty: 5 });
    // Lot 0 → SO-A(2); lot 1 → SO-A(1)+SO-B(1).
    expect(out[0]!.assignedTo).toEqual([{ soDocNo: 'SO-A', deliveryDate: '2026-10-01', qty: 2 }]);
    expect(out[1]!.assignedTo).toEqual([
      { soDocNo: 'SO-A', deliveryDate: '2026-10-01', qty: 1 },
      { soDocNo: 'SO-B', deliveryDate: '2026-11-01', qty: 1 },
    ]);
  });

  test('null-safe: empty lots / over-assignment are capped, never negative', () => {
    expect(distributeAssignedToLots([], 5, [])).toEqual([]);
    const [lot] = distributeAssignedToLots([3], 99, [{ soDocNo: 'SO-X', deliveryDate: null, qty: 99 }]);
    expect(lot).toMatchObject({ assignedQty: 3, freeQty: 0 });
  });
});

// A sofa SO demand line (SF-100, W1, RED fabric). item_group carries the
// category (the catFromGroup fallback the sofa bucketer documents), so no
// catalog row is needed. `delivery` null on BOTH dates = an undated line.
const sofaDemand = (id: string, docNo: string, qty: number, delivery: string | null): Row => ({
  id, doc_no: docNo, item_code: 'SF-100', description: 'Lotti Sofa',
  item_group: 'sofa', variants: { fabricCode: 'RED' }, qty,
  warehouse_id: 'W1', line_delivery_date: delivery, line_no: 1, created_at: '2026-07-01T00:00:00Z',
  cancelled: false,
  so: { debtor_name: 'Acme', status: 'CONFIRMED', so_date: '2026-07-01', customer_delivery_date: delivery, processing_date: null, customer_state: null },
});

// A sofa PO supply line for SF-100 → W1. `variant` null builds the legacy '' key.
const sofaPoLine = (poNumber: string, qty: number, variant: Row | null, eta: string): Row => ({
  material_code: 'SF-100', item_group: 'sofa', variants: variant ?? {}, qty, received_qty: 0,
  delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  warehouse_id: 'W1', so_item_id: null,
  po: {
    po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    purchase_location_id: 'W1', supplier_id: null,
  },
});

describe('computeMrp — sofa legacy "" pool fallback (audit D2, mirrors section 7 R4)', () => {
  test('a sofa variant with NO own PO draws the legacy "" pool (no more phantom shortage)', async () => {
    // Demand a 5-set of RED sofa; the ONLY supply is a legacy '' PO for 5.
    // Before the fix the sofa path never looked at the legacy pool, so this
    // read as shortage 5 while the same-warehouse PO sat open — over-ordering.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [sofaDemand('si-sofa', 'SO-9', 5, '2026-12-01')],
      purchase_order_items: [sofaPoLine('PO-LEGACY-SOFA', 5, null, '2026-10-01')],
    });

    const res = await computeMrp(sb as any, opts);
    expect(res.skus).toHaveLength(0); // SOFA never lands in the general rows
    expect(res.sofaSets).toHaveLength(1);
    const set = res.sofaSets[0]!;
    expect(set.variantKey).toBe('fabriccode=red');
    expect(set.orderedQty).toBe(5);
    expect(set.shortageQty).toBe(0);
    expect(set.poNumber).toBe('PO-LEGACY-SOFA');
  });

  test('a sofa variant WITH its own PO ignores the legacy pool entirely (fallback, never additive)', async () => {
    // Demand 8; own RED PO 5 + legacy '' PO 5. The R4 rule: legacy answers ONLY
    // when the variant's own pool is empty. Correct: covered 5 by PO-RED-SOFA,
    // shortage 3. (Additive bug shape: covered 8, shortage 0 — the same
    // physical legacy units counted on top.)
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [sofaDemand('si-sofa', 'SO-9', 8, '2026-12-01')],
      purchase_order_items: [
        sofaPoLine('PO-RED-SOFA', 5, { fabricCode: 'RED' }, '2026-11-01'),
        sofaPoLine('PO-LEGACY-SOFA', 5, null, '2026-10-01'),
      ],
    });

    const res = await computeMrp(sb as any, opts);
    expect(res.sofaSets).toHaveLength(1);
    const set = res.sofaSets[0]!;
    expect(set.orderedQty).toBe(5);       // own pool only
    expect(set.shortageQty).toBe(3);      // legacy NOT folded on top
    expect(set.poNumber).toBe('PO-RED-SOFA');
    expect(res.totals.sofaSetShortageCount).toBe(1);
  });

  test('a sofa line with NO variant key ("" bucket) never self-folds', async () => {
    // '' demand draws the '' pool as its OWN pool — the useLegacy guard
    // (vkey !== '') must not double it.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [{ ...sofaDemand('si-sofa', 'SO-9', 8, '2026-12-01'), variants: {} }],
      purchase_order_items: [sofaPoLine('PO-LEGACY-SOFA', 5, null, '2026-10-01')],
    });

    const res = await computeMrp(sb as any, opts);
    const set = res.sofaSets[0]!;
    expect(set.variantKey).toBe('');
    expect(set.orderedQty).toBe(5);
    expect(set.shortageQty).toBe(3);
  });
});

describe('computeMrp — includeUndated is visibility, not a demand filter (audit D6)', () => {
  const dated = demandRed(5); // si-red / SO-1, delivery 2026-12-01
  const undated: Row = {
    ...demandRed(5), id: 'si-undated', doc_no: 'SO-2',
    line_delivery_date: null,
    so: { debtor_name: 'Beta', status: 'CONFIRMED', so_date: '2026-07-01', customer_delivery_date: null, processing_date: null, customer_state: null },
  };
  const tables = () => ({
    ...BASE_TABLES,
    mfg_sales_order_items: [dated, undated],
    purchase_order_items: [poLine('PO-RED', 6, { fabricCode: 'RED' }, '2026-11-01')],
  });

  test('ONE allocation under both flags: the dated line reads identically; false only hides the undated row', async () => {
    const shown = await computeMrp(fakeSb(tables()) as any, { ...opts, includeUndated: true });
    const hidden = await computeMrp(fakeSb(tables()) as any, { ...opts, includeUndated: false });

    // includeUndated=true — both lines visible: dated covered 5 by the PO,
    // undated (allocated LAST) takes the 1 leftover unit and shows short 4.
    expect(shown.skus).toHaveLength(1);
    expect(shown.skus[0]!.lines).toHaveLength(2);
    const shownDated = shown.skus[0]!.lines.find((l) => l.soItemId === 'si-red')!;
    const shownUndated = shown.skus[0]!.lines.find((l) => l.soItemId === 'si-undated')!;
    expect(shownDated).toMatchObject({ source: 'po', poNumber: 'PO-RED', shortageQty: 0, qty: 5 });
    expect(shownUndated).toMatchObject({ poNumber: 'PO-RED', shortageQty: 4 });

    // includeUndated=false — the undated ROW disappears, its allocation does
    // not: the dated line is byte-identical to the shown run (same PO, same
    // coverage), which is the "SO->PO and PO->SO can never disagree" claim.
    expect(hidden.skus).toHaveLength(1);
    expect(hidden.skus[0]!.lines).toHaveLength(1);
    expect(hidden.skus[0]!.lines[0]).toMatchObject({ soItemId: 'si-red', source: 'po', poNumber: 'PO-RED', shortageQty: 0, qty: 5 });
    expect(hidden.skus[0]!.qtyNeeded).toBe(5);       // visible demand only
    expect(hidden.skus[0]!.poOutstanding).toBe(6);   // bucket totals unchanged
    expect(hidden.totals.shortageUnits).toBe(0);     // hidden shortage not counted
  });

  test('a bucket whose ONLY demand is undated renders no row when hidden', async () => {
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [undated],
      purchase_order_items: [poLine('PO-RED', 6, { fabricCode: 'RED' }, '2026-11-01')],
    });
    const res = await computeMrp(sb as any, { ...opts, includeUndated: false });
    expect(res.skus).toHaveLength(0);
    expect(res.totals.skuCount).toBe(0);
  });
});

describe('computeMrp — SHIPPED no longer creates demand (audit D4)', () => {
  test('a SHIPPED-status SO line is done, matching so-stock-allocation / reservations', async () => {
    const shipped: Row = {
      ...demandRed(5),
      so: { debtor_name: 'Acme', status: 'SHIPPED', so_date: '2026-07-01', customer_delivery_date: '2026-12-01', processing_date: null, customer_state: null },
    };
    const sb = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: [shipped] });
    const res = await computeMrp(sb as any, opts);
    expect(res.skus).toHaveLength(0);
    expect(res.totals.shortageUnits).toBe(0);
  });
});

describe('computeMrp — mrp_load_truncated guard (audit D3)', () => {
  test('a demand read that fills the row cap throws instead of planning on a slice', async () => {
    const flood: Row[] = Array.from({ length: 5001 }, (_, i) => ({
      ...demandRed(1), id: `si-${i}`, doc_no: `SO-${i}`,
    }));
    const sb = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: flood });
    await expect(computeMrp(sb as any, opts)).rejects.toThrow(/mrp_load_truncated/);
  });

  test('a PO-supply read that fills the row cap throws too', async () => {
    const flood: Row[] = Array.from({ length: 5001 }, () => poLine('PO-N', 1, { fabricCode: 'RED' }, '2026-11-01'));
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [demandRed(1)],
      purchase_order_items: flood,
    });
    await expect(computeMrp(sb as any, opts)).rejects.toThrow(/mrp_load_truncated/);
  });
});
