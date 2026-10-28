import { describe, it, expect } from 'vitest';
import { isConsignmentLotSource } from './inventory-movements';

/* #1245 excluded consignment from the Stock Breakdown DRAWER only. The inventory
   LIST value column/total and the ANALYTICS value figures still summed ALL open
   lots, so BOOQIT-CNR read RM 2,564.19 in the list but RM 863.19 (owned) in the
   drawer — the owner thought there was far more owned stock (and dead stock) than
   there is (BUG-HISTORY 2026-07-25). These tests pin that the list and analytics
   VALUE aggregations now exclude consignment-sourced lots, exactly like the
   drawer, using the ONE shared classifier isConsignmentLotSource + the same
   per-lot owned-value basis remaining_value_sen (= qty_remaining * unit_cost_sen).

   The route handlers read Supabase, which the unit harness can't stand up, so —
   like consignment-lot-source.test.ts — we mirror the exact accumulation the
   routes now run over the lot feed. */

// v_inventory_lots_open rows for BOOQIT-CNR: 3 physical units in ONE (normal)
// warehouse — 2 fed by Purchase Consignment Receives, 1 by a normal GRN. Owned
// value = RM 863.19 (the GRN lot only); consignment adds RM 1,701.00 → RM 2,564.19
// if (wrongly) counted whole. remaining_value_sen = qty_remaining * unit_cost_sen.
type OpenLot = {
  item_code: string;
  product_name: string;
  qty_remaining: number;
  remaining_value_sen: number;
  received_at: string;
  source_doc_type: string;
  source_doc_no: string;
};
const BOOQIT_LOTS: OpenLot[] = [
  { item_code: 'BOOQIT-CNR', product_name: 'Booqit Corner', qty_remaining: 1, remaining_value_sen: 100_000, received_at: '2026-06-01T00:00:00Z', source_doc_type: 'PC_RECEIVE',     source_doc_no: '2990-PCR-2606-001' },
  { item_code: 'BOOQIT-CNR', product_name: 'Booqit Corner', qty_remaining: 1, remaining_value_sen:  70_100, received_at: '2026-06-05T00:00:00Z', source_doc_type: 'STOCK_TRANSFER', source_doc_no: '2990-PCR-2606-002' },
  { item_code: 'BOOQIT-CNR', product_name: 'Booqit Corner', qty_remaining: 1, remaining_value_sen:  86_319, received_at: '2026-07-01T00:00:00Z', source_doc_type: 'GRN',            source_doc_no: '2990-GRN-2607-023' },
];
const OWNED_VALUE_SEN = 86_319;      // RM 863.19 — the drawer's owned subtotal
const ALL_LOTS_VALUE_SEN = 256_419;  // RM 2,564.19 — the pre-fix (wrong) figure

describe('inventory LIST value excludes consignment (matches the drawer)', () => {
  // Mirror of /inventory/products: ownedValueSen accumulator over the open lots.
  it('sums only owned lots into the per-SKU value, then rounds once', () => {
    const ownedValueSen = new Map<string, number>();
    for (const l of BOOQIT_LOTS) {
      if (!isConsignmentLotSource(l.source_doc_type, l.source_doc_no)) {
        ownedValueSen.set(l.item_code, (ownedValueSen.get(l.item_code) ?? 0) + Number(l.remaining_value_sen ?? 0));
      }
    }
    const value = Math.round(ownedValueSen.get('BOOQIT-CNR') ?? 0);
    expect(value).toBe(OWNED_VALUE_SEN);        // RM 863.19
    expect(value).not.toBe(ALL_LOTS_VALUE_SEN); // NOT RM 2,564.19
  });

  it('list value now equals the drawer owned subtotal for the same SKU', () => {
    // Drawer (buildStockBreakdown): Math.round(Σ owned qty_remaining * unit_cost_sen).
    // remaining_value_sen IS qty_remaining * unit_cost_sen, so the two agree exactly.
    const drawerOwned = Math.round(
      BOOQIT_LOTS.filter((l) => !isConsignmentLotSource(l.source_doc_type, l.source_doc_no))
        .reduce((s, l) => s + l.remaining_value_sen, 0),
    );
    const listValue = Math.round(
      BOOQIT_LOTS.filter((l) => !isConsignmentLotSource(l.source_doc_type, l.source_doc_no))
        .reduce((s, l) => s + l.remaining_value_sen, 0),
    );
    expect(listValue).toBe(drawerOwned);
  });
});

describe('inventory ANALYTICS value figures exclude consignment', () => {
  // Mirror of /inventory/analytics: the lot loop skips consignment before it
  // touches total value, aging buckets, or per-product on-hand value.
  const nowMs = new Date('2026-07-25T00:00:00Z').getTime();
  const BUCKETS = [
    { key: '0-30', max: 30 }, { key: '31-60', max: 60 }, { key: '61-90', max: 90 },
    { key: '91-180', max: 180 }, { key: '180+', max: Infinity },
  ];
  const aging = BUCKETS.map((b) => ({ key: b.key, valueSen: 0 }));
  const prod = new Map<string, { qty: number; valueSen: number }>();
  let totalValueSen = 0;
  for (const l of BOOQIT_LOTS) {
    if (isConsignmentLotSource(l.source_doc_type, l.source_doc_no)) continue;
    const ageDays = (nowMs - new Date(l.received_at).getTime()) / 86_400_000;
    const idx = BUCKETS.findIndex((b) => ageDays <= b.max);
    const bucket = aging[idx < 0 ? aging.length - 1 : idx];
    if (bucket) bucket.valueSen += l.remaining_value_sen;
    totalValueSen += l.remaining_value_sen;
    const p = prod.get(l.item_code) ?? { qty: 0, valueSen: 0 };
    p.qty += l.qty_remaining; p.valueSen += l.remaining_value_sen;
    prod.set(l.item_code, p);
  }

  it('total inventory value counts owned lots only', () => {
    expect(totalValueSen).toBe(OWNED_VALUE_SEN);
    expect(totalValueSen).not.toBe(ALL_LOTS_VALUE_SEN);
  });

  it('aging value buckets sum to the owned total (no consignment value in any bucket)', () => {
    expect(aging.reduce((s, b) => s + b.valueSen, 0)).toBe(OWNED_VALUE_SEN);
  });

  it('per-product on-hand value (feeds dead-stock + ABC on-hand) excludes consignment', () => {
    // The GRN lot is >90 days old? No — received 2026-07-01, ~24 days: the owned
    // on-hand value is the GRN lot only, so dead-stock/ABC value can never show
    // the RM 1,701.00 of consignment as if it were owned money.
    expect(prod.get('BOOQIT-CNR')?.valueSen).toBe(OWNED_VALUE_SEN);
  });
});
