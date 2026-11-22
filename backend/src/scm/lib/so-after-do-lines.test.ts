import { describe, expect, test } from 'vitest';
import { afterDoQtyChangeAllowed, doLinePatchFromSoLine, type SoLineShape } from './so-after-do-lines';

describe('afterDoQtyChangeAllowed — a qty change needs the whole line on one DO', () => {
  test('fully delivered on one DO, not invoiced -> allowed', () => {
    expect(afterDoQtyChangeAllowed(3, 3, 0, 0)).toBe(true);
  });
  test('fully delivered and fully invoiced by one line -> allowed', () => {
    expect(afterDoQtyChangeAllowed(3, 3, 3, 1)).toBe(true);
  });
  test('part-delivered (DO holds fewer than the order) -> refused', () => {
    expect(afterDoQtyChangeAllowed(3, 2, 0, 0)).toBe(false);
  });
  test('fully delivered but part-invoiced -> refused', () => {
    expect(afterDoQtyChangeAllowed(3, 3, 2, 1)).toBe(false);
  });
  test('billed across more than one invoice line -> refused (would double-count)', () => {
    expect(afterDoQtyChangeAllowed(3, 3, 3, 2)).toBe(false);
  });
});

describe('doLinePatchFromSoLine — the DO line mirror of an SO line', () => {
  const base: SoLineShape = {
    item_code: 'BF-QUEEN', item_group: 'bedframe', description: 'Queen frame', description2: null,
    uom: 'UNIT', qty: 2, unit_price_sen: 100000, discount_sen: 5000, unit_cost_sen: 40000, variants: null,
  };

  test('line_total / line_cost / margin are derived and clamped from qty, price, discount, cost', () => {
    const p = doLinePatchFromSoLine(base);
    expect(p.qty).toBe(2);
    expect(p.line_total_sen).toBe(2 * 100000 - 5000); // 195000
    expect(p.line_cost_sen).toBe(2 * 40000); // 80000
    expect(p.line_margin_sen).toBe(195000 - 80000);
  });

  test('a discount larger than the gross never makes the line total negative', () => {
    const p = doLinePatchFromSoLine({ ...base, qty: 1, unit_price_sen: 1000, discount_sen: 9999 });
    expect(p.line_total_sen).toBe(0);
  });

  test('item code, group and variants carry across so the stock bucket follows a spec change', () => {
    const p = doLinePatchFromSoLine({ ...base, item_code: 'BF-KING', variants: { fabricCode: 'F1' } });
    expect(p.item_code).toBe('BF-KING');
    expect(p.item_group).toBe('bedframe');
    expect(p.variants).toEqual({ fabricCode: 'F1' });
  });
});
