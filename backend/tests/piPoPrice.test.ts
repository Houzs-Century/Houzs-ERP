/* pi-po-price — the ordered price beside the billed one.
 *
 * Owner 2026-09-12: 「Purchase Invoice 应该要有两个价钱 … 有差异的话，我们基本上
 * 就要做 checking」. The trap this suite exists for is the one a join gets wrong
 * quietly: a line with NO purchase order behind it must read "no PO price", not
 * "the supplier overcharged by the whole amount". */
import { describe, it, expect } from 'vitest';
import {
  comparePiLinePrice,
  poUnitPriceByPiLine,
  piPriceDifferenceSummary,
} from '../src/scm/lib/pi-po-price';

describe('comparePiLinePrice', () => {
  it('reports the difference when the supplier billed more than we ordered', () => {
    expect(comparePiLinePrice(48_500, 41_500)).toEqual({
      poUnitPriceSen: 41_500, supplierUnitPriceSen: 48_500, diffSen: 7_000, differs: true,
    });
  });

  it('reports a CREDIT the same way — the supplier billed less', () => {
    expect(comparePiLinePrice(40_000, 41_500).diffSen).toBe(-1_500);
    expect(comparePiLinePrice(40_000, 41_500).differs).toBe(true);
  });

  it('agreeing prices are not a difference', () => {
    expect(comparePiLinePrice(41_500, 41_500).differs).toBe(false);
    expect(comparePiLinePrice(41_500, 41_500).diffSen).toBe(0);
  });

  it('NO purchase-order price is null, never a full-amount overcharge', () => {
    expect(comparePiLinePrice(48_500, null)).toEqual({
      poUnitPriceSen: null, supplierUnitPriceSen: 48_500, diffSen: null, differs: false,
    });
  });

  it('an order placed at zero (unbound SKU, keyed in at the invoice) IS a difference', () => {
    /* supplierCostFor writes 0 for an unbound SKU — "key in at PI". That is a
       real ordered price of zero, not a missing one, so the whole billed amount
       is the difference and a person should look at it. */
    expect(comparePiLinePrice(48_500, 0)).toEqual({
      poUnitPriceSen: 0, supplierUnitPriceSen: 48_500, diffSen: 48_500, differs: true,
    });
  });
});

describe('poUnitPriceByPiLine — the two hops', () => {
  const grnItems = [
    { id: 'g1', purchase_order_item_id: 'p1' },
    { id: 'g2', purchase_order_item_id: null },   // received without a PO
  ];
  const poItems = [{ id: 'p1', unit_price_sen: 41_500 }];

  it('walks PI line -> grn item -> po item', () => {
    const out = poUnitPriceByPiLine([{ id: 'l1', grn_item_id: 'g1' }], grnItems, poItems);
    expect(out.get('l1')).toBe(41_500);
  });

  it('a PI-native service line (no grn_item_id) has no ordered price', () => {
    const out = poUnitPriceByPiLine([{ id: 'l2', grn_item_id: null }], grnItems, poItems);
    expect(out.get('l2')).toBeNull();
  });

  it('a receipt with no purchase order behind it has no ordered price', () => {
    const out = poUnitPriceByPiLine([{ id: 'l3', grn_item_id: 'g2' }], grnItems, poItems);
    expect(out.get('l3')).toBeNull();
  });

  it('a grn item we cannot see resolves to null, not to zero', () => {
    const out = poUnitPriceByPiLine([{ id: 'l4', grn_item_id: 'gone' }], grnItems, poItems);
    expect(out.get('l4')).toBeNull();
  });

  it('every line gets an entry, so a caller never reads undefined', () => {
    const out = poUnitPriceByPiLine(
      [{ id: 'l1', grn_item_id: 'g1' }, { id: 'l2', grn_item_id: null }],
      grnItems, poItems,
    );
    expect([...out.keys()].sort()).toEqual(['l1', 'l2']);
  });
});

describe('piPriceDifferenceSummary — what the header says', () => {
  it('counts only the lines that differ, and weights by qty', () => {
    expect(piPriceDifferenceSummary([
      { qty: 2, supplierUnitPriceSen: 48_500, poUnitPriceSen: 41_500 }, // +7,000 x 2
      { qty: 1, supplierUnitPriceSen: 41_500, poUnitPriceSen: 41_500 }, // agrees
      { qty: 3, supplierUnitPriceSen: 10_000, poUnitPriceSen: null },   // nothing to compare
    ])).toEqual({ linesDiffering: 1, totalDiffSen: 14_000 });
  });

  it('a credit and a charge do not hide each other in the COUNT', () => {
    const s = piPriceDifferenceSummary([
      { qty: 1, supplierUnitPriceSen: 48_500, poUnitPriceSen: 41_500 },
      { qty: 1, supplierUnitPriceSen: 34_500, poUnitPriceSen: 41_500 },
    ]);
    expect(s.linesDiffering).toBe(2);
    expect(s.totalDiffSen).toBe(0);
  });

  it('nothing to compare is a quiet summary, not a zero-difference claim', () => {
    expect(piPriceDifferenceSummary([{ qty: 5, supplierUnitPriceSen: 1, poUnitPriceSen: null }]))
      .toEqual({ linesDiffering: 0, totalDiffSen: 0 });
  });
});
