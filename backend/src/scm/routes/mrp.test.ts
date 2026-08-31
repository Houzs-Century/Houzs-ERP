// Unit tests for computeMrp's variant coverage math and its read paging.
//
// The MRP coverage engine is FLOATING by design: coverage is recomputed at read
// time, pooled globally across SOs, and evaporates on delivery (owner-confirmed
// intentional — NOT under test here).
//
// TWO RULES ARE PINNED HERE.
//
// 1. SUPPLY MATCHES DEMAND ON THE FULL BUCKET KEY. There used to be a fallback
//    that let the same-warehouse EMPTY-variant ('') PO pool cover a
//    specific-variant demand bucket that had no PO of its own. The owner ruled it
//    out twice (2026-08-16) — 「variant 不一样的话 应该不能拿来给那个SO 用不是吗?」
//    — so a PO whose variants differ may not cover that SO line, and the tests
//    that used to assert the fallback now assert its absence. What survives from
//    audit R4 is the other half of that rule: a variant bucket's own PO is its
//    only supply, never doubled by anything.
//
// 2. EVERY MULTI-ROW READ IS PAGED. See the fake's row ceiling below.
//
// Route-level coverage isn't possible in this harness (scm rides Supabase
// Postgres; the harness rebuilds only the D1 side), so these drive computeMrp
// through a minimal fake PostgREST client — same shape as so-converted-po.test.ts,
// extended with the operators this engine chains (eq / in / order / limit / range).
import { describe, expect, test } from 'vitest';
import { computeMrp, mrpStockAssignment, stockAssignmentKey, parseIncludeUndated, InvalidQueryFlag } from './mrp';
import { NO_BUFFERS } from '../lib/lead-time';
import { distributeAssignedToLots, isMakeToOrderCategory } from '../lib/inventory-movements';

type Row = Record<string, unknown>;

/* THE FAKE ENFORCES POSTGREST'S REAL ROW CEILING, and that is the whole point of
   it. A live PostgREST returns at most `max-rows` (1000 on this project) per
   response, drops the remainder, and reports NOTHING — no error, no flag. A
   `.limit(5000)` does not lift it. The old fake honoured `.limit(n)` literally,
   so the engine's `rows.length >= 5000` truncation guard looked testable here
   while being unfireable in production (1000 >= 5000 is false), and a read that
   silently lost 12,920 of prod's 13,920 demand rows had a green test suite.

   Capping every response at 1000 makes the fake lie the way the server lies, so
   a fixture larger than the cap can only be read in full by code that PAGES. */
const PGRST_MAX_ROWS = 1000;

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
    // An UPPER bound only, exactly like the real one — it can lower the ceiling,
    // never raise it past PGRST_MAX_ROWS. Nothing in mrp.ts chains it any more.
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    order() { return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    private result() {
      const windowed = this.window ? this.rows.slice(this.window[0], this.window[1] + 1) : this.rows;
      // The server-side ceiling: silently truncate, never signal.
      return { data: windowed.slice(0, PGRST_MAX_ROWS), error: null as null };
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
  item_code: 'BF-100', item_group: 'bedframe', variants: variant ?? {}, qty, received_qty: 0,
  delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  warehouse_id: 'W1', so_item_id: null,
  po: {
    po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    purchase_location_id: 'W1', supplier_id: null,
  },
});

describe('computeMrp — supply must match demand on the FULL variant key', () => {
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

    const res = await computeMrp(asSb(sb), opts);
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

  test('a variant demand with NO own PO is NOT covered by an empty-variant PO', async () => {
    // Demand 5 of RED, no RED PO — only an empty-variant '' PO for 5 in the same
    // warehouse for the same SKU. That PO is for a bedframe with no fabric
    // recorded; RED is a bedframe with one. Owner 2026-08-16: different variant,
    // different thing, so it cannot be handed to this SO.
    //
    // This test asserted the OPPOSITE until 2026-08-16 ("fallback preserved").
    // The fallback is gone: shortage 5, and PO Outstanding shows 0 rather than
    // parking 5 units on the row that will never receive them.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [demandRed(5)],
      purchase_order_items: [poLine('PO-LEGACY', 5, null, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), opts);
    expect(res.skus).toHaveLength(1);
    const row = res.skus[0]!;
    expect(row.variantKey).toBe('fabriccode=red');
    expect(row.poOutstanding).toBe(0);  // the '' pool is not this row's supply
    expect(row.shortage).toBe(5);       // …so the whole order is still to buy
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]!.source).toBe('shortage');
    expect(row.lines[0]!.poNumber).toBeNull();
    expect(res.totals.shortageUnits).toBe(5);
  });

  test('the empty-variant demand bucket still draws the empty-variant PO (its OWN pool)', async () => {
    // The rule is "match on the full key", not "distrust ''". A line that really
    // has no variant belongs in the '' bucket, and the '' PO is that bucket's own
    // supply — nothing about removing the fallback may break this direction.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [{ ...demandRed(5), variants: {} }],
      purchase_order_items: [poLine('PO-LEGACY', 5, null, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), opts);
    const row = res.skus[0]!;
    expect(row.variantKey).toBe('');
    expect(row.poOutstanding).toBe(5);
    expect(row.shortage).toBe(0);
    expect(row.lines[0]!.poNumber).toBe('PO-LEGACY');
  });

  test('two different real variants never cover each other', async () => {
    // The fallback only ever reached the '' bucket, so RED-vs-BLUE was already
    // correct. Pinned anyway: it is the same rule, and it is the one a reader
    // will assume the fix was about.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [demandRed(4)],
      purchase_order_items: [poLine('PO-BLUE', 9, { fabricCode: 'BLUE' }, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), opts);
    const red = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(red.poOutstanding).toBe(0);
    expect(red.shortage).toBe(4);
  });

  test('MATTRESS is unaffected: no key attributes, so its key is "" either way', async () => {
    // ATTRS_BY_GROUP.mattress is [] (shared/variant-key.ts), so a mattress line
    // keys to '' whatever variants it carries — it was never eligible for the
    // fallback (`bucket.vkey !== ''` was false) and nothing about it moves. The
    // fabricCode below is deliberately noise: it must not enter the key.
    const mattress: Row = {
      ...demandRed(3), id: 'si-mat', doc_no: 'SO-MAT', item_code: 'MAT-100',
      item_group: 'mattress', variants: { fabricCode: 'RED' },
    };
    const matPo: Row = {
      ...poLine('PO-MAT', 3, null, '2026-10-01'), item_code: 'MAT-100', item_group: 'mattress',
    };
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [mattress],
      purchase_order_items: [matPo],
    });

    const res = await computeMrp(asSb(sb), opts);
    expect(res.skus).toHaveLength(1);
    const row = res.skus[0]!;
    expect(row.itemCode).toBe('MAT-100');
    expect(row.variantKey).toBe('');   // mattress carries no soft attrs
    expect(row.poOutstanding).toBe(3); // same bucket, so still covered
    expect(row.shortage).toBe(0);
  });

  test('a NULL item_group line keys to "" on BOTH sides, so it matches its own kind and nothing else', async () => {
    /* THE NULL-GROUP TRAP, pinned as it actually behaves. variantKeyOf resolves
       attributes through `ATTRS_BY_GROUP[group] ?? []`, so a null/unknown group
       yields NO attributes and the line keys to '' EVEN THOUGH it carries a real
       fabric. That is true of demand and of PO supply alike, and it is unchanged
       by this fix — deliberately. See the long note in routes/mrp.ts section 7
       for why the group is NOT re-derived from the product master: stock's key is
       the STORED inventory_balances.variant_key, which MRP cannot re-derive, so
       deriving here would move demand and supply off the stock they must match.

       Consequence, asserted below: a null-group line with a RED fabric does NOT
       join the RED bucket — it sits in '' with the other unclassified rows, and
       is covered by '' supply. Mis-grouped, but mis-grouped identically on every
       side, which is what keeps the arithmetic self-consistent. */
    const nullGroup: Row = {
      ...demandRed(2), id: 'si-null', doc_no: 'SO-NULL',
      item_group: null, variants: { fabricCode: 'RED' },
    };
    const sb = fakeSb({
      ...BASE_TABLES,
      // Two demand lines, same SKU + warehouse, both claiming fabric RED: one
      // properly grouped as a bedframe, one with a null group.
      mfg_sales_order_items: [demandRed(2), nullGroup],
      purchase_order_items: [
        poLine('PO-RED', 2, { fabricCode: 'RED' }, '2026-10-01'),
        { ...poLine('PO-NULLGRP', 2, { fabricCode: 'RED' }, '2026-10-02'), item_group: null },
      ],
    });

    const res = await computeMrp(asSb(sb), opts);
    // TWO buckets, not one: the null-group line did not join 'fabriccode=red'.
    expect(res.skus.map((s) => s.variantKey).sort()).toEqual(['', 'fabriccode=red']);

    const red = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(red.qtyNeeded).toBe(2);
    expect(red.poOutstanding).toBe(2);   // PO-RED only
    expect(red.shortage).toBe(0);

    // The null-group demand is matched by the null-group PO — same '' bucket on
    // both sides. It is NOT left stranded by the fallback removal.
    const unclassified = res.skus.find((s) => s.variantKey === '')!;
    expect(unclassified.qtyNeeded).toBe(2);
    expect(unclassified.poOutstanding).toBe(2);
    expect(unclassified.shortage).toBe(0);
    expect(unclassified.lines[0]!.poNumber).toBe('PO-NULLGRP');
  });
});

// A stock balance row for BF-100 → W1 with the RED variant key.
const stockRed = (qty: number): Row => ({
  item_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty,
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

    const res = await computeMrp(asSb(sb), opts);
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

    const res = await computeMrp(asSb(sb), opts);
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
  item_code: 'SF-100', item_group: 'sofa', variants: variant ?? {}, qty, received_qty: 0,
  delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  warehouse_id: 'W1', so_item_id: null,
  po: {
    po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    purchase_location_id: 'W1', supplier_id: null,
  },
});

describe('computeMrp — sofa supply matches on the full variant key too', () => {
  test('a sofa variant with NO own PO is NOT covered by an empty-variant sofa PO', async () => {
    // Demand a 5-set of RED sofa; the ONLY supply is an empty-variant '' PO
    // for 5. Sofa's key is fabricCode + seatHeight + legHeight, so that PO is a
    // sofa with no fabric, no seat and no leg recorded — it cannot stand in for
    // a colour-matched set (owner 2026-08-16).
    //
    // Audit D2 (2026-08-01) added the fallback here to mirror section 7's; this
    // test asserted coverage until the owner's ruling. Both mirrors are now
    // removed together, which is the property that keeps the two paths honest.
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [sofaDemand('si-sofa', 'SO-9', 5, '2026-12-01')],
      purchase_order_items: [sofaPoLine('PO-LEGACY-SOFA', 5, null, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), opts);
    expect(res.skus).toHaveLength(0); // SOFA never lands in the general rows
    expect(res.sofaSets).toHaveLength(1);
    const set = res.sofaSets[0]!;
    expect(set.variantKey).toBe('fabriccode=red');
    expect(set.orderedQty).toBe(0);
    expect(set.shortageQty).toBe(5);
    expect(set.poNumber).toBeNull();
    expect(res.totals.sofaSetShortageCount).toBe(1);
  });

  test('a sofa variant WITH its own PO draws only that PO, never doubled', async () => {
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

    const res = await computeMrp(asSb(sb), opts);
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

    const res = await computeMrp(asSb(sb), opts);
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

  /* THE INVARIANT THE 2026-08-18 DEFAULT FLIP RESTS ON.
     Showing undated demand by default is only safe because an undated line can
     never take supply from a dated one: byDateAsc (mrp.ts) returns 1 for null,
     so nulls sort after every real date and reach the PO queue last. If that
     order ever inverted, the flip would stop being a display change and start
     re-routing goods — an undated line would jump a promised one. So it is
     pinned here, from the OUTPUT, under both flag values and with the scarce
     row fed in FIRST so insertion order cannot be what produces the answer. */
  test('a dated line wins the scarce bucket over an undated one — under either flag, whatever the row order', async () => {
    // PO-RED supplies 6. Both lines want 5 of the same variant bucket.
    const scarce = () => ({
      ...BASE_TABLES,
      mfg_sales_order_items: [undated, dated],      // undated deliberately FIRST
      purchase_order_items: [poLine('PO-RED', 6, { fabricCode: 'RED' }, '2026-11-01')],
    });

    for (const includeUndated of [true, false]) {
      const res = await computeMrp(fakeSb(scarce()) as any, { ...opts, includeUndated });
      const datedLine = res.skus[0]!.lines.find((l) => l.soItemId === 'si-red')!;

      // The dated line is whole in both runs: it reached the queue first.
      expect([includeUndated, datedLine.source]).toEqual([includeUndated, 'po']);
      expect([includeUndated, datedLine.poNumber]).toEqual([includeUndated, 'PO-RED']);
      expect([includeUndated, datedLine.shortageQty]).toEqual([includeUndated, 0]);
      expect([includeUndated, datedLine.qty]).toEqual([includeUndated, 5]);

      /* The undated line eats the 1 leftover unit and carries the shortage —
         counted whether or not it was RENDERED, which is the whole point of
         tallying before the visibility `continue`. */
      expect([includeUndated, res.undated.lines]).toEqual([includeUndated, 1]);
      expect([includeUndated, res.undated.shortageUnits]).toEqual([includeUndated, 4]);
      expect([includeUndated, res.undated.hidden]).toEqual([includeUndated, !includeUndated]);
    }
  });
});

/* ── The hidden half is REPORTED, and hiding still changes nothing (2026-08-16)
      ───────────────────────────────────────────────────────────────────────────
   Owner: "明明这个东西没有 ready,可是我的 MRP 却 show 不出来." On production the
   default view returned 82 of 163 live 2990 SO-item ids and 8 of 68 short sofa
   sets — half the book, removed in silence. `result.undated` is the count that
   ends the silence, and these tests hold it to two properties:

     1. it counts EXACTLY the rows the flag removes, with their REAL allocation
        shortage — so it can never become a second, disagreeing demand walk
        (which is the audit-D6 divergence in miniature);
     2. adding it moved no allocation figure — what is DISPLAYED must not change
        what is PLANNED.

   Property 1 is what bites: count after the `continue`, or only on the hiding
   branch, and the arithmetic below stops adding up. */

/** The allocation figures a row carries — everything the plan DECIDES, and
    nothing it merely displays (qtyNeeded / shortage / totals are per-view
    aggregates and legitimately differ between the two flag values). */
const allocOf = (res: Awaited<ReturnType<typeof computeMrp>>) => {
  const out = new Map<string, Record<string, unknown>>();
  for (const s of res.skus) {
    for (const l of s.lines) {
      out.set(l.soItemId, {
        source: l.source, poNumber: l.poNumber, poEta: l.poEta,
        shortageQty: l.shortageQty, stockQty: l.stockQty, qty: l.qty,
      });
    }
  }
  for (const s of res.sofaSets) {
    out.set(s.soItemId, {
      poNumber: s.poNumber, poEta: s.poEta, shortageQty: s.shortageQty,
      stockQty: s.stockQty, orderedQty: s.orderedQty, qty: s.qty,
    });
  }
  return out;
};

describe('computeMrp — undated demand is COUNTED even when it is hidden', () => {
  // Two dated + two undated lines against a PO for 6. Dated take 5 and 1;
  // the undated pair (allocated LAST) get nothing → 3 and 4 short.
  const d1 = { ...demandRed(5), id: 'si-d1', doc_no: 'SO-D1' };
  const d2 = {
    ...demandRed(1), id: 'si-d2', doc_no: 'SO-D2',
    line_delivery_date: '2026-12-02',
    so: { debtor_name: 'Acme', status: 'CONFIRMED', so_date: '2026-07-01', customer_delivery_date: '2026-12-02', processing_date: null, customer_state: null },
  };
  const undatedSo = (id: string, docNo: string, qty: number): Row => ({
    ...demandRed(qty), id, doc_no: docNo, line_delivery_date: null,
    so: { debtor_name: 'Beta', status: 'CONFIRMED', so_date: '2026-07-01', customer_delivery_date: null, processing_date: null, customer_state: null },
  });
  const tables = () => ({
    ...BASE_TABLES,
    mfg_sales_order_items: [d1, d2, undatedSo('si-u1', 'SO-U1', 3), undatedSo('si-u2', 'SO-U2', 4)],
    purchase_order_items: [poLine('PO-RED', 6, { fabricCode: 'RED' }, '2026-11-01')],
  });

  test('the tally equals exactly the rows the flag removed, and carries their real shortage', async () => {
    const shown = await computeMrp(fakeSb(tables()), { ...opts, includeUndated: true });
    const hidden = await computeMrp(fakeSb(tables()), { ...opts, includeUndated: false });

    const shownIds = [...allocOf(shown).keys()];
    const hiddenIds = new Set(allocOf(hidden).keys());
    const removed = shownIds.filter((id) => !hiddenIds.has(id));
    expect(removed.sort()).toEqual(['si-u1', 'si-u2']);

    // (1) the count IS the size of the removed set — not "some undated rows".
    expect(hidden.undated.lines).toBe(removed.length);
    // (2) and it is the same number when nothing is removed: an observation of
    //     the demand, not a by-product of the hiding branch.
    expect(shown.undated.lines).toBe(removed.length);

    // (3) the shortage reported for the hidden set is the shortage the ONE
    //     allocation actually gave those rows — read back off the shown run.
    const shownAlloc = allocOf(shown);
    const realShort = removed.reduce((acc, id) => acc + (shownAlloc.get(id)!.shortageQty as number), 0);
    expect(realShort).toBe(7);                       // 3 + 4, the PO's 6 all went to the dated pair
    expect(hidden.undated.shortageUnits).toBe(realShort);
    expect(shown.undated.shortageUnits).toBe(realShort);

    // (4) the response says WHICH it did, so a caller whose flag was not
    //     honoured can tell from the answer alone.
    expect(hidden.undated.hidden).toBe(true);
    expect(shown.undated.hidden).toBe(false);

    // The visible aggregate still reflects the visible rows only — the count is
    // the extra fact, it does not smuggle hidden demand into the totals.
    expect(hidden.totals.shortageUnits).toBe(0);
    expect(shown.totals.shortageUnits).toBe(7);
  });

  test('DISPLAY does not change PLANNING: every dated row allocates identically under both flags', async () => {
    const shown = allocOf(await computeMrp(fakeSb(tables()), { ...opts, includeUndated: true }));
    const hidden = allocOf(await computeMrp(fakeSb(tables()), { ...opts, includeUndated: false }));

    for (const [id, row] of hidden) expect([id, row]).toEqual([id, shown.get(id)]);
    expect([...hidden.keys()].sort()).toEqual(['si-d1', 'si-d2']);
    // Bucket-level SUPPLY is a property of the pool, never of the view.
    const bucketOf = (r: Awaited<ReturnType<typeof computeMrp>>) =>
      r.skus.map((s) => ({ stock: s.stock, poOutstanding: s.poOutstanding }));
    expect(bucketOf(await computeMrp(fakeSb(tables()), { ...opts, includeUndated: false })))
      .toEqual(bucketOf(await computeMrp(fakeSb(tables()), { ...opts, includeUndated: true })));
  });

  test('sofa is tallied SEPARATELY — section 8 ignores catFilter, so a blended count would overstate every other tab', async () => {
    const tbl = {
      ...BASE_TABLES,
      mfg_sales_order_items: [
        undatedSo('si-u1', 'SO-U1', 3),                    // BEDFRAME, undated
        sofaDemand('si-s1', 'SO-S1', 2, null),             // SOFA, undated
        sofaDemand('si-s2', 'SO-S2', 2, '2026-12-01'),     // SOFA, dated
      ],
      purchase_order_items: [],
    };
    const res = await computeMrp(fakeSb(tbl), { ...opts, includeUndated: false });

    // Split, never summed: the Bedframe tab must read 1, not 2.
    expect(res.undated.lines).toBe(1);
    expect(res.undated.shortageUnits).toBe(3);
    expect(res.undated.sofaSets).toBe(1);
    expect(res.undated.sofaShortageUnits).toBe(2);
    // And the hidden sofa set really is absent from the rendered sets.
    expect(res.sofaSets.map((s) => s.soItemId)).toEqual(['si-s2']);
  });
});

describe('parseIncludeUndated — a truthy-looking value must never be silently false', () => {
  test('?includeUndated=1 is TRUE — the production report that started this', () => {
    // Before 2026-08-16 the parser was `=== 'true'`, so this returned the
    // default plan (82 SO-item ids, 8 short sofa sets) with nothing saying the
    // request had been ignored.
    expect(parseIncludeUndated('1')).toBe(true);
  });

  test('every accepted spelling, either case, with whitespace', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' True ', 'YES', 'On']) {
      expect([v, parseIncludeUndated(v)]).toEqual([v, true]);
    }
    for (const v of ['false', '0', 'no', 'off', 'FALSE', ' Off ']) {
      expect([v, parseIncludeUndated(v)]).toEqual([v, false]);
    }
  });

  test('omitted is the documented default — FALSE, undated demand is hidden', () => {
    /* Owner, 2026-08-18, ruling on a build that had flipped this to true:
       "这个应该是要把没有日期的藏起来的,不过我点 show no date 它才会出来."

       The measurement that started the work stands — the default view held 82 of
       163 live 2990 SO-item ids and 8 of 68 short sofa sets — but the inference
       drawn from it did not. What the owner could not see was never the ROWS; it
       was that rows were being withheld at all, because the page said nothing.
       Hiding is legitimate here: this is the ordering worklist and an undated
       line is not orderable. Hiding SILENTLY is what was broken. The page-level
       banner was the 2026-08-16 answer; the owner deleted it on 2026-08-20
       (「黄色的也delete掉」), so what ends the silence now is the always-visible
       "Show no-date" checkbox plus the per-row "No date" tag —
       frontend mrpUndated.test.tsx pins both, and pins the banner's absence.

       Requiring a delivery date was considered and rejected for a separate
       reason that still holds: a forced date gets a FAKE one typed into it, and
       a fake date outranks a real one in an allocation sorted BY date.

       This is VISIBILITY only; the allocation-order pin below is what makes that
       claim checkable rather than asserted. */
    expect(parseIncludeUndated(undefined)).toBe(false);
  });

  test('an explicit "false" still hides — the toggle did not become decorative', () => {
    // The page sends the flag in BOTH directions now (mrp-queries.ts). If this
    // ever collapsed to true, unticking "Show no-date" would silently no-op.
    expect(parseIncludeUndated('false')).toBe(false);
    expect(parseIncludeUndated('0')).toBe(false);
  });

  test('anything else THROWS rather than collapsing onto false', () => {
    for (const v of ['maybe', 'y', 't', '2', '', 'true;drop', 'null']) {
      expect(() => parseIncludeUndated(v)).toThrow(InvalidQueryFlag);
    }
    // The refusal has to name the parameter and the accepted spellings, or the
    // caller is told "no" without being told what "yes" looks like.
    expect(() => parseIncludeUndated('y')).toThrow(/includeUndated.*true.*1.*yes.*on/s);
  });
});

describe('computeMrp — SHIPPED no longer creates demand (audit D4)', () => {
  test('a SHIPPED-status SO line is done, matching so-stock-allocation / reservations', async () => {
    const shipped: Row = {
      ...demandRed(5),
      so: { debtor_name: 'Acme', status: 'SHIPPED', so_date: '2026-07-01', customer_delivery_date: '2026-12-01', processing_date: null, customer_state: null },
    };
    const sb = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: [shipped] });
    const res = await computeMrp(asSb(sb), opts);
    expect(res.skus).toHaveLength(0);
    expect(res.totals.shortageUnits).toBe(0);
  });
});

/* WHAT THIS DESCRIBE REPLACED, because deleting a test needs a reason on the
   record. It used to be `computeMrp — mrp_load_truncated guard (audit D3)`, two
   tests that flooded a table with 5,001 rows and asserted computeMrp threw
   `mrp_load_truncated`. They passed, and they were measuring the fake rather
   than the server: the old fake honoured `.limit(5000)` literally, so 5,001 rows
   really did come back as 5,000 and really did trip `rows.length >= 5000`.
   Against a live PostgREST capped at 1000, that comparison is 1000 >= 5000 — the
   guard could not fire, and prod confirmed it never had (2026-08-16: 13,920
   matching demand rows, page served, no throw, ~93% of demand silently absent).

   A guard that cannot detect the thing it is named after is worse than none, so
   it is gone rather than re-tuned, and the tests that certified it are gone with
   it. What replaces them asserts the property that actually matters — the engine
   READS EVERY ROW — against a fake that now enforces the real 1000-row ceiling.
   Every test below fails on the pre-fix engine. */
describe('computeMrp — every multi-row read is paged past PostgREST\'s 1000-row cap', () => {
  test('demand: 2,500 open SO lines all reach the plan, not the first 1,000', async () => {
    // One line per SKU so each becomes its own bucket and the count is exact.
    // Pre-fix this returned 1,000 rows and 1,000 buckets, with no error anywhere.
    const flood: Row[] = Array.from({ length: 2500 }, (_, i) => ({
      ...demandRed(1), id: `si-${String(i).padStart(5, '0')}`, doc_no: `SO-${i}`, item_code: `BF-${i}`,
    }));
    const sb = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: flood });

    const res = await computeMrp(asSb(sb), opts);
    expect(res.skus).toHaveLength(2500);
    expect(res.totals.skuCount).toBe(2500);
    expect(res.totals.shortageUnits).toBe(2500); // no supply anywhere → all short
  });

  test('demand: the LAST line by id is planned — the owner\'s "new SO is invisible" bug', async () => {
    // The read is ordered by id, and prod's ids are uuids, so a brand-new sales
    // order lands at an arbitrary rank — 10,687th of 13,920 for the one the owner
    // hit on 2026-08-16, i.e. far past the ceiling. Here the tail line is the one
    // that used to be dropped; it must appear, and be convertible to a PO
    // (soItemId is what the UI one-clicks).
    const flood: Row[] = Array.from({ length: 1500 }, (_, i) => ({
      ...demandRed(1), id: `si-${String(i).padStart(5, '0')}`, doc_no: `SO-${i}`, item_code: `BF-${i}`,
    }));
    const sb = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: flood });

    const res = await computeMrp(asSb(sb), opts);
    const tail = res.skus.find((s) => s.itemCode === 'BF-1499');
    expect(tail).toBeDefined();
    expect(tail!.lines[0]).toMatchObject({ soItemId: 'si-01499', soDocNo: 'SO-1499', source: 'shortage' });
  });

  test('PO supply: 1,500 open PO lines all count as supply', async () => {
    // 1,500 POs of 1 unit each against demand for 1,500. Pre-fix only 1,000 were
    // read, so 500 units of real, open, already-ordered supply read as shortage
    // and the page invited a duplicate purchase.
    const poFlood: Row[] = Array.from({ length: 1500 }, (_, i) =>
      poLine(`PO-${i}`, 1, { fabricCode: 'RED' }, '2026-11-01'));
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [demandRed(1500)],
      purchase_order_items: poFlood,
    });

    const res = await computeMrp(asSb(sb), opts);
    const row = res.skus[0]!;
    expect(row.qtyNeeded).toBe(1500);
    expect(row.poOutstanding).toBe(1500);
    expect(row.shortage).toBe(0);
  });

  test('stock: a balance row past the cap is still stock, not a phantom shortage', async () => {
    // 1,200 balance buckets; the demanded SKU's balance is the last one. Pre-fix
    // it fell outside the 1,000-row response and MRP planned a purchase for goods
    // already sitting in the warehouse (prod holds 1,065 balance rows).
    const balances: Row[] = Array.from({ length: 1199 }, (_, i) => ({
      item_code: `OTHER-${String(i).padStart(5, '0')}`, warehouse_id: 'W1', variant_key: '', qty: 1,
    }));
    balances.push({ item_code: 'ZZ-LAST', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty: 7 });
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: [{ ...demandRed(7), item_code: 'ZZ-LAST' }],
      inventory_balances: balances,
    });

    const res = await computeMrp(asSb(sb), opts);
    const row = res.skus[0]!;
    expect(row.stock).toBe(7);
    expect(row.shortage).toBe(0);
    expect(row.lines[0]!.source).toBe('stock');
  });

  test('supplier bindings: a binding past the cap still names the SKU\'s supplier', async () => {
    // 1,400 bindings (prod: 2,660). A SKU whose binding fell past the cap showed
    // no supplier at all — the difference between a row staff can convert to a
    // purchase order and a row they cannot.
    const codes = Array.from({ length: 1400 }, (_, i) => `BF-${i}`);
    const sb = fakeSb({
      ...BASE_TABLES,
      mfg_sales_order_items: codes.map((code, i) => ({
        ...demandRed(1), id: `si-${String(i).padStart(5, '0')}`, doc_no: `SO-${i}`, item_code: code,
      })),
      supplier_material_bindings: codes.map((code, i) => ({
        item_code: code, material_kind: 'mfg_product', is_main_supplier: true,
        supplier_id: `sup-${i}`, supplier: { code: `S${i}`, name: `Supplier ${i}` },
      })),
    });

    const res = await computeMrp(asSb(sb), opts);
    const last = res.skus.find((s) => s.itemCode === 'BF-1399')!;
    expect(last.mainSupplierCode).toBe('S1399');
    expect(last.mainSupplierName).toBe('Supplier 1399');
    // …and nothing lost its supplier along the way.
    expect(res.skus.every((s) => s.mainSupplierCode !== null)).toBe(true);
  });

  test('product master: a category owned only by a row past the cap still lists', async () => {
    // The category tab list walks the whole catalogue (2,293 rows in prod).
    const products: Row[] = Array.from({ length: 1300 }, (_, i) => ({
      code: `P-${String(i).padStart(5, '0')}`, name: `P${i}`, category: 'BEDFRAME',
    }));
    products.push({ code: 'ZZ-LAST', name: 'Last', category: 'ACCESSORY' });
    const sb = fakeSb({ ...BASE_TABLES, mfg_products: products });

    const res = await computeMrp(asSb(sb), opts);
    expect(res.categories).toEqual(['ACCESSORY', 'BEDFRAME']);
  });
});

/* ── The read wave (2026-08-17) ────────────────────────────────────────────────
   PR #2300 made this engine correct by paging every read and said, in its own
   body, what that cost: "roughly a dozen round trips to on the order of a
   hundred ... They are sequential." The owner then reported the MRP page and the
   SO list (which calls computeMrp once per load) as very laggy — ~5.2s each on
   prod company 1.

   Most of those round trips are independent, so they now run bounded-concurrent.
   Three things have to stay true for that to be a performance change rather than
   a behaviour change, and none of them is visible by reading the diff:

     1. reads actually OVERLAP — otherwise the restructure silently reverted and
        every other test here still passes;
     2. the overlap is BOUNDED — an unbounded fan-out exhausts Hyperdrive's pool
        and trades latency for instability (the owner's standing rule);
     3. the ANSWER does not depend on which read finishes first — the real hazard
        concurrency introduces, and the one a timing-based test would miss.

   The fake below resolves asynchronously (the shipped one resolves on a
   microtask) so that overlap is observable at all. */
/* The backend tsconfig targets Workers and does not declare `process`, so reach
   it through globalThis with an explicit shape. The test ASSERTS it is present
   rather than skipping when it is not — a guard that silently turns the check
   off is how a test comes to pass over nothing. */
type UnhandledHost = {
  on(event: 'unhandledRejection', listener: (e: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (e: unknown) => void): void;
};
const unhandledHost = (globalThis as { process?: UnhandledHost }).process;

/* ONE cast site for the fake client. computeMrp's `sb` is untyped, so every
   call would otherwise write its own `as any` — the tests below add none. */
type SbArg = Parameters<typeof computeMrp>[0];
const asSb = (fake: unknown): SbArg => fake as SbArg;

function instrumentedSb(tables: Record<string, Row[]>, delayFor: (table: string) => number) {
  const stats = { reads: 0, maxInFlight: 0 };
  let inFlight = 0;
  const inner = fakeSb(tables);
  return {
    stats,
    sb: {
      from(table: string) {
        const q = (inner as unknown as { from: (t: string) => Record<string, unknown> }).from(table);
        const origThen = (q as { then: (...a: unknown[]) => unknown }).then.bind(q);
        (q as Record<string, unknown>).then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => {
          stats.reads++;
          inFlight++;
          stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
          return new Promise((resolve) => setTimeout(resolve, delayFor(table)))
            .then(() => { inFlight--; })
            .then(() => origThen(onF, onR));
        };
        return q;
      },
    },
  };
}

describe('computeMrp — the read wave overlaps, stays bounded, and cannot change the answer', () => {
  // 600 open docs → 3 batches of 200 in the soDeliverableRemaining loop, which
  // is where ~two thirds of the engine's round trips live.
  const manyDocs = (): Row[] => Array.from({ length: 600 }, (_, i) => ({
    ...demandRed(1), id: `si-${String(i).padStart(5, '0')}`, doc_no: `SO-${i}`, item_code: `BF-${i}`,
  }));

  test('independent reads run concurrently — they no longer wait for one another', async () => {
    const { sb, stats } = instrumentedSb({ ...BASE_TABLES, mfg_sales_order_items: manyDocs() }, () => 1);
    await computeMrp(asSb(sb), opts);
    // Before this change every read waited for the previous one, so the honest
    // reading of maxInFlight was exactly 1. If this assertion ever fails again
    // at 1, the engine has gone back to sequential and the page is slow again.
    expect(stats.maxInFlight).toBeGreaterThan(1);
  });

  test('concurrency stays within the declared bound (pool safety)', async () => {
    const { sb, stats } = instrumentedSb({ ...BASE_TABLES, mfg_sales_order_items: manyDocs() }, () => 1);
    await computeMrp(asSb(sb), opts);
    // MRP_READ_CONCURRENCY is 6. The wave at the top of computeMrp fires a fixed
    // handful alongside it, so the ceiling asserted here is deliberately loose —
    // what it forbids is an UNBOUNDED fan-out that scales with the data (600 docs
    // would put 3 batches + their inner reads in flight and keep climbing as the
    // book grows).
    expect(stats.maxInFlight).toBeLessThanOrEqual(16);
  });

  test('the plan is identical whichever read finishes first', async () => {
    const tables = {
      ...BASE_TABLES,
      mfg_sales_order_items: [demandRed(10)],
      purchase_order_items: [poLine('PO-1', 4, { fabricCode: 'RED' }, '2026-11-01')],
      inventory_balances: [{ item_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty: 3 }],
      warehouses: [{ id: 'W1', code: 'W1', name: 'Main', is_active: true }],
      mfg_products: [{ id: 'p1', code: 'BF-100', name: 'Baron Bedframe', category: 'BEDFRAME' }],
    };
    // Arm 1: the supply reads come back LAST. Arm 2: they come back FIRST.
    const slowSupply = instrumentedSb(tables, (t) =>
      t === 'purchase_order_items' || t === 'inventory_balances' ? 12 : 0);
    const fastSupply = instrumentedSb(tables, (t) =>
      t === 'purchase_order_items' || t === 'inventory_balances' ? 0 : 12);

    const a = await computeMrp(asSb(slowSupply.sb), opts);
    const b = await computeMrp(asSb(fastSupply.sb), opts);
    // `asOf` is a wall-clock stamp taken per run, so it differs between any two
    // calls and always did. Everything the page RENDERS is compared — and when
    // this was first run, asOf was the only field that differed at all.
    const { asOf: _a, ...planA } = a;
    const { asOf: _b, ...planB } = b;
    expect(planA).toEqual(planB);
    // And the arithmetic is still right, not merely stable: 10 needed, 3 in
    // stock, 4 on an open PO, 3 short.
    expect(a.skus[0]).toMatchObject({ qtyNeeded: 10, stock: 3, poOutstanding: 4, shortage: 3 });
  });

  test('a failing read still throws mrp_load_failed, not an unhandled rejection', async () => {
    // Hoisting reads into a wave is exactly where an un-awaited rejection would
    // escape as an unhandled rejection and kill the request instead of returning
    // the route's 500. eager() is what prevents that; this is the pin.
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    expect(unhandledHost).toBeDefined();
    unhandledHost!.on('unhandledRejection', onUnhandled);
    try {
      const broken = {
        from: (table: string) => {
          const q = fakeSb({ ...BASE_TABLES, mfg_sales_order_items: [demandRed(1)] }).from(table) as unknown as Record<string, unknown>;
          if (table === 'inventory_balances') {
            q.then = (onF: (v: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: 'balances exploded' } }).then(onF);
          }
          return q;
        },
      };
      await expect(computeMrp(asSb(broken), opts)).rejects.toThrow(/mrp_load_failed: balances exploded/);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      unhandledHost!.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

/* ── MRP ALLOCATES ON THE DATE THE CUSTOMER IS ACTUALLY WAITING FOR ──────────
 *
 * MRP hands pooled supply out greedily, earliest delivery first. It ranked on
 * `line_delivery_date ?? so.customer_delivery_date` — the customer's ORIGINAL
 * promise, plus a per-line MIRROR of it — while the delivery board and PO
 * coverage had always ranked on `amended_delivery_date ?? customer_delivery_
 * date`. A customer who rescheduled therefore moved on the board and did NOT
 * move here, in the queue that decides who gets the scarce stock and what is
 * ordered first. Owner 2026-08-18: there is no production in this business,
 * only the delivery date, and every screen plans on the same one.
 *
 * THE MIRROR IS THE HALF THAT MATTERS, and it is why these fixtures carry a
 * `line_delivery_date` at all. `line_delivery_date_overridden = false` means the
 * line date is a copy of the header date (mig 0172's apply_so_header_followers
 * writes the pair). A reschedule writes the HEADER only, so the mirror keeps
 * serving the pre-amendment date — on production 2026-08-18 all 5 live lines on
 * the 3 rescheduled orders were exactly this shape. A fix that consulted the
 * amended date only AFTER the line date would move none of them, and would pass
 * a test whose fixtures left `line_delivery_date` null.
 */
const demandFor = (docNo: string, dates: Row): Row => ({
  id: `si-${docNo}`, doc_no: docNo, item_code: 'BF-100', description: 'Baron Bedframe',
  item_group: 'bedframe', variants: { fabricCode: 'RED' }, qty: 1,
  warehouse_id: 'W1', line_no: 1, created_at: '2026-07-01T00:00:00Z', cancelled: false,
  // The mirror: a copy of the header's original date, flag false.
  line_delivery_date: dates['customer_delivery_date'],
  line_delivery_date_overridden: false,
  so: {
    debtor_name: 'Acme', status: 'CONFIRMED', so_date: '2026-07-01',
    amended_delivery_date: null, processing_date: null, customer_state: null,
    ...dates,
  },
});

/* EXACTLY ONE unit against two orders of one each — scarcity is the experiment.
   With two units both are covered and the ranking is unobservable. */
const oneUnitWorld = (a: Row, b: Row) => fakeSb({
  ...BASE_TABLES,
  mfg_sales_order_items: [a, b],
  inventory_balances: [{ item_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty: 1 }],
  warehouses: [{ id: 'W1', code: 'W1', name: 'Main', is_active: true }],
  mfg_products: [{ id: 'p1', code: 'BF-100', name: 'Baron Bedframe', category: 'BEDFRAME' }],
});

const sourceByDoc = (res: Awaited<ReturnType<typeof computeMrp>>) =>
  Object.fromEntries(res.skus[0]!.lines.map((l) => [l.soDocNo, l.source]));

describe('computeMrp — allocation ranks on the EFFECTIVE delivery date', () => {
  test('an order rescheduled EARLIER takes the stock from one whose original was earlier', async () => {
    // SO-1 promised 2026-11-01, never moved. SO-2 sold for 2026-12-01 and pulled
    // forward to 2026-10-01 — the date the board has shown all along.
    // Old ranking: SO-1 (11-01) vs SO-2 (12-01, from its stale mirror) → SO-1.
    const sb = oneUnitWorld(
      demandFor('SO-1', { customer_delivery_date: '2026-11-01' }),
      demandFor('SO-2', { customer_delivery_date: '2026-12-01', amended_delivery_date: '2026-10-01' }),
    );

    const res = await computeMrp(asSb(sb), opts);

    expect(res.skus).toHaveLength(1);
    expect(res.skus[0]!.stock).toBe(1);              // non-vacuity: there IS one unit to fight over
    expect(sourceByDoc(res)).toEqual({ 'SO-2': 'stock', 'SO-1': 'shortage' });
    // …and the date the page shows for the rescheduled line is the amended one,
    // not the mirror it used to print.
    expect(res.skus[0]!.lines.find((l) => l.soDocNo === 'SO-2')!.deliveryDate).toBe('2026-10-01');
  });

  test('an order rescheduled LATER loses the stock to one whose original was later', async () => {
    // The mirror image — the direction a one-sided fix silently drops.
    const sb = oneUnitWorld(
      demandFor('SO-1', { customer_delivery_date: '2026-11-01', amended_delivery_date: '2027-01-01' }),
      demandFor('SO-2', { customer_delivery_date: '2026-12-01' }),
    );

    const res = await computeMrp(asSb(sb), opts);

    expect(res.skus[0]!.stock).toBe(1);
    expect(sourceByDoc(res)).toEqual({ 'SO-2': 'stock', 'SO-1': 'shortage' });
  });

  test('CONTROL — with no amendment the earlier original still wins', async () => {
    // A fix that read the wrong column, or inverted the comparator, passes both
    // tests above and fails this one.
    const sb = oneUnitWorld(
      demandFor('SO-1', { customer_delivery_date: '2026-11-01' }),
      demandFor('SO-2', { customer_delivery_date: '2026-12-01' }),
    );

    const res = await computeMrp(asSb(sb), opts);

    expect(sourceByDoc(res)).toEqual({ 'SO-1': 'stock', 'SO-2': 'shortage' });
  });

  test('the order-by date follows the amendment too — it is derived from the delivery date', async () => {
    /* orderByDate = effective delivery date − category lead days, and it is what
       the page SORTS the to-order list by. With no lead-time config the lead is
       zero, so it must equal the amended date exactly — pinning that the
       amendment reaches the "when to order" answer and not just the display. */
    const sb = oneUnitWorld(
      demandFor('SO-1', { customer_delivery_date: '2026-12-01', amended_delivery_date: '2026-10-01' }),
      demandFor('SO-2', { customer_delivery_date: '2026-12-05' }),
    );

    const res = await computeMrp(asSb(sb), opts);

    const l1 = res.skus[0]!.lines.find((l) => l.soDocNo === 'SO-1')!;
    expect(l1.deliveryDate).toBe('2026-10-01');
    expect(l1.orderByDate).toBe('2026-10-01');
  });
});

/* HARD BINDING, COMPANY 1 (owner 2026-08-31, option 甲: 「甲 可是针对的是 co1 而已
   目前而已」).

   The stored allocator has bound company-1 bedframe / `(SP)` mattress lines to
   their own purchase order since 2026-08-30 (bug 0572). MRP planned the same
   lines against the pool, so the two engines disagreed about the same order —
   and MRP was the one telling the owner to buy goods that were already standing
   in the warehouse under a blank variant key with his own PO's name on them. */
describe('company 1: a bound line is planned from its own purchase order only', () => {
  const co1 = { ...opts, companyId: 1 };
  const boundPo = (poNumber: string, qty: number, receivedQty: number, soItemId: string, variant: Row | null, eta: string): Row => ({
    item_code: 'BF-100', item_group: 'bedframe', variants: variant ?? {}, qty, received_qty: receivedQty,
    delivery_date: eta, supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
    warehouse_id: 'W1', so_item_id: soItemId,
    po: {
      po_number: poNumber, status: 'SUBMITTED', expected_at: eta,
      supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
      purchase_location_id: 'W1', supplier_id: null,
    },
  });
  /* Every per-company read is `.eq('company_id', …)`-scoped, and the fake filters
     literally, so a fixture row without the column is invisible to a scoped run.
     Stamped here rather than on each row: forgetting it does not fail loudly, it
     just returns an empty plan. */
  const stamp = (co: number) => (rows: Row[]): Row[] => rows.map((r) => ({ company_id: co, ...r }));
  const world = (tables: Record<string, Row[]>, co = 1) => {
    const add = stamp(co);
    return fakeSb(Object.fromEntries(Object.entries({
      ...BASE_TABLES,
      warehouses: [{ id: 'W1', code: 'W1', name: 'Main', is_active: true }],
      mfg_products: [{ id: 'p1', code: 'BF-100', name: 'Baron Bedframe', category: 'BEDFRAME' }],
      ...tables,
    }).map(([t, rows]) => [t, add(rows as Row[])])));
  };

  test('its own PO is RECEIVED: covered, even though the units landed under a blank variant', async () => {
    /* THE OWNER'S CASE. The AutoCount stock snapshot carries no variant, so the
       received units sit under '' while the sales-order line asks for RED. The
       exact-key stock lookup finds nothing, and before this rule MRP reported a
       shortage for goods that are in the warehouse with this line's name on
       them. The receipt of its OWN purchase order is the evidence. */
    const sb = world({
      mfg_sales_order_items: [demandRed(5)],
      purchase_order_items: [boundPo('PO-OWN', 5, 5, 'si-red', { fabricCode: 'RED' }, '2026-10-01')],
      inventory_balances: [{ item_code: 'BF-100', warehouse_id: 'W1', variant_key: '', qty: 5 }],
    });

    const res = await computeMrp(asSb(sb), co1);

    const row = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(row.qtyNeeded).toBe(5);
    expect(row.shortage).toBe(0);
    expect(res.totals.shortageUnits).toBe(0);
  });

  test('its own PO is still OUTSTANDING: covered on that PO, and the PO is named', async () => {
    const sb = world({
      mfg_sales_order_items: [demandRed(5)],
      purchase_order_items: [boundPo('PO-OWN', 5, 0, 'si-red', { fabricCode: 'RED' }, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), co1);

    const row = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(row.shortage).toBe(0);
    expect(row.lines[0]!.poNumber).toBe('PO-OWN');
  });

  test('NO purchase order of its own: short, even with matching stock sitting in its bucket', async () => {
    /* The exclusivity half, and the one that changes an answer the old code was
       happy with: exact-variant stock in the line's own bucket does NOT light a
       bound line. Company 1 buys for the order; unattached stock belongs to
       nobody until a purchase order says so. */
    const sb = world({
      mfg_sales_order_items: [demandRed(5)],
      inventory_balances: [{ item_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty: 5 }],
    });

    const res = await computeMrp(asSb(sb), co1);

    const row = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(row.stock).toBe(5);      // the stock is real and still reported
    expect(row.shortage).toBe(5);   // and none of it is this line's
  });

  test("another line's dedicated PO is not free supply", async () => {
    /* A bound purchase order leaves the pool entirely. Before, a PO raised for
       SO-2's line could cover SO-1's demand in the same bucket — which is the
       duplicate-coverage mirror of the same mistake. */
    const sb = world({
      mfg_sales_order_items: [demandRed(5)],
      purchase_order_items: [boundPo('PO-SOMEONE-ELSE', 5, 0, 'si-other', { fabricCode: 'RED' }, '2026-10-01')],
    });

    const res = await computeMrp(asSb(sb), co1);

    const row = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(row.poOutstanding).toBe(0);
    expect(row.shortage).toBe(5);
  });

  test('company 2 keeps the pooled model — the rule is company-1 only, for now', async () => {
    const sb = world({
      mfg_sales_order_items: [demandRed(5)],
      inventory_balances: [{ item_code: 'BF-100', warehouse_id: 'W1', variant_key: 'fabriccode=red', qty: 5 }],
    }, 2);

    const res = await computeMrp(asSb(sb), { ...opts, companyId: 2 });

    const row = res.skus.find((s) => s.variantKey === 'fabriccode=red')!;
    expect(row.shortage).toBe(0);   // pooled stock still covers it
  });
});
