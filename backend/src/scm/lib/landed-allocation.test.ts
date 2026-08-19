// landed-allocation folds a GRN's freight/"平摊" service charge into the FIFO
// lot cost of its goods lines. Whatever it decides becomes the carrying cost of
// the stock, and every COGS, margin and recost downstream copies it. It was
// ported verbatim from 2990 and arrived with no test.
//
// The invariant its own docblock states — "Σ allocated === chargePool EXACTLY,
// no sen created or lost" — is the one worth pinning, because a rounding leak
// is invisible per line and only shows up as inventory that will not reconcile.

import { describe, it, expect } from 'vitest';
import { allocateLandedCharges, normalizeAllocationMethod, type AllocLine } from './landed-allocation';

const goods = (id: string, qty: number, unitPriceSen: number, unitM3Milli = 0): AllocLine => ({
  id,
  itemGroup: 'stock',
  itemCode: `MAT-${id}`,
  qty,
  amountSen: qty * unitPriceSen,
  unitPriceSen,
  unitM3Milli,
});

const freight = (amountSen: number): AllocLine => ({
  id: 'svc',
  itemGroup: 'service',
  itemCode: 'TRANSPORTATION',
  qty: 1,
  amountSen,
  unitPriceSen: amountSen,
  unitM3Milli: 0,
});

const sumAllocated = (r: { goods: Array<{ allocatedChargeSen: number }> }) =>
  r.goods.reduce((s, g) => s + g.allocatedChargeSen, 0);

describe('normalizeAllocationMethod', () => {
  it('defaults to QTY for anything it does not recognise', () => {
    expect(normalizeAllocationMethod('value')).toBe('VALUE');
    expect(normalizeAllocationMethod(' cbm ')).toBe('CBM');
    for (const raw of [null, undefined, '', 'WEIGHT', 42]) expect(normalizeAllocationMethod(raw)).toBe('QTY');
  });
});

describe('allocateLandedCharges', () => {
  it('with no service line the landed cost IS the base cost — a true no-op', () => {
    // Most GRNs have no freight line. If this path moved a single sen, every
    // ordinary receipt would recost itself for no reason.
    const r = allocateLandedCharges([goods('a', 3, 1000), goods('b', 2, 2000)], 'QTY', 1);
    expect(r.chargePoolMyr).toBe(0);
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([0, 0]);
    expect(r.goods.map((g) => g.landedUnitCostMyr)).toEqual([1000, 2000]);
  });

  it('spends the WHOLE pool and not one sen more, even when it does not divide', () => {
    // 1000 sen across three equal lines is 333.33 each. Rounding each
    // independently loses a sen from inventory on every such receipt; the last
    // positive line absorbs the remainder so the column reconciles exactly.
    const r = allocateLandedCharges([goods('a', 1, 500), goods('b', 1, 500), goods('c', 1, 500), freight(1000)], 'QTY', 1);
    expect(r.chargePoolMyr).toBe(1000);
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([333, 333, 334]);
    expect(sumAllocated(r)).toBe(1000);
  });

  it('QTY weights by quantity, and folds the charge into the per-unit cost', () => {
    const r = allocateLandedCharges([goods('a', 1, 1000), goods('b', 3, 1000), freight(800)], 'QTY', 1);
    expect(r.effectiveMethod).toBe('QTY');
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([200, 600]);
    expect(r.goods.map((g) => g.landedUnitCostMyr)).toEqual([1200, 1200]);
    expect(sumAllocated(r)).toBe(800);
  });

  it('VALUE weights by goods value, so a dear line carries more of the freight', () => {
    // Same quantities, different prices: under QTY these would split 50/50.
    const r = allocateLandedCharges([goods('a', 2, 1000), goods('b', 2, 3000), freight(800)], 'VALUE', 1);
    expect(r.effectiveMethod).toBe('VALUE');
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([200, 600]);
    expect(sumAllocated(r)).toBe(800);
  });

  it('CBM weights by volume', () => {
    const r = allocateLandedCharges([goods('a', 1, 1000, 1000), goods('b', 1, 1000, 3000), freight(800)], 'CBM', 1);
    expect(r.effectiveMethod).toBe('CBM');
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([200, 600]);
  });

  it('falls back to QTY when the chosen basis sums to zero, instead of dividing by it', () => {
    // Volume is unknown on most products, so a CBM GRN whose lines all carry
    // unit_m3 = 0 is the normal case, not a corner. Without the fallback the
    // freight lands nowhere and the stock is carried below its true cost.
    const r = allocateLandedCharges([goods('a', 1, 1000, 0), goods('b', 3, 1000, 0), freight(800)], 'CBM', 1);
    expect(r.effectiveMethod).toBe('QTY');
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([200, 600]);
    expect(sumAllocated(r)).toBe(800);
  });

  it('puts the remainder on the last line that has QUANTITY, not merely the last line', () => {
    // A trailing zero-qty goods line would swallow the remainder into a
    // per-unit charge of round(alloc / 0) = 0, and that sen would vanish from
    // every lot while still counting as "allocated".
    const r = allocateLandedCharges(
      [goods('a', 3, 1000), goods('b', 3, 1000), goods('c', 3, 1000), goods('zero', 0, 1000), freight(10)],
      'QTY',
      1,
    );
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([3, 3, 4, 0]);
    expect(sumAllocated(r)).toBe(10);
  });

  it('converts a foreign-currency freight charge at the GRN rate', () => {
    // The pool is MYR sen. Pooling the foreign amount unconverted would carry
    // USD freight as if it were ringgit — a 4x understatement of landed cost.
    const r = allocateLandedCharges([goods('a', 2, 1000), freight(100)], 'QTY', 4.5);
    expect(r.chargePoolMyr).toBe(450);
    expect(r.goods[0]!.baseUnitCostMyr).toBe(4500);
    expect(r.goods[0]!.landedUnitCostMyr).toBe(4500 + 225);
  });

  it('leaves the goods alone when there is nowhere to put the charge', () => {
    // Freight on a receipt whose only goods line has zero quantity: the pool has
    // no home. It must not be smeared onto a line that received nothing.
    const r = allocateLandedCharges([goods('a', 0, 1000), freight(800)], 'QTY', 1);
    expect(r.chargePoolMyr).toBe(800);
    expect(r.goods.map((g) => g.allocatedChargeSen)).toEqual([0]);
    expect(r.goods[0]!.landedUnitCostMyr).toBe(1000);
  });
});
