import { describe, expect, it } from 'vitest';
import { invalidLineNumberBody, parseLineNumbers } from './line-numbers';


describe('parseLineNumbers', () => {
  it('accepts ordinary numeric and numeric-string line values', () => {
    const r = parseLineNumbers({
      qty: { value: 3 },
      unitPriceSen: { value: '12500' },
      discountSen: { value: 0 },
    });
    expect(r).toEqual({ ok: true, nums: { qty: 3, unitPriceSen: 12500, discountSen: 0 } });
  });

  it('preserves a legitimate zero rather than treating it as absent', () => {
    const r = parseLineNumbers({ unitPriceSen: { value: 0, fallback: 999 } });
    expect(r).toEqual({ ok: true, nums: { unitPriceSen: 0 } });
  });

  it('falls back when a field is absent, because absent != garbage', () => {
    const r = parseLineNumbers({
      qty: { value: undefined, fallback: 1 },
      discountSen: { value: null },
    });
    expect(r).toEqual({ ok: true, nums: { qty: 1, discountSen: 0 } });
  });

  it('rejects a non-numeric string instead of persisting NaN', () => {
    const r = parseLineNumbers({ qty: { value: 'abc' }, unitPriceSen: { value: 100 } });
    expect(r).toEqual({ ok: false, invalid: ['qty'] });
  });

  it('rejects NaN, Infinity and -Infinity', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(parseLineNumbers({ qty: { value: bad } }).ok).toBe(false);
    }
  });

  it('rejects values that coerce to NaN via objects and arrays', () => {
    const r = parseLineNumbers({
      qty: { value: {} },
      unitPriceSen: { value: [1, 2] },
      discountSen: { value: 5 },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.invalid.sort()).toEqual(['qty', 'unitPriceSen']);
  });

  it('reports every offending field at once, not just the first', () => {
    const r = parseLineNumbers({ qty: { value: 'x' }, unitPriceSen: { value: 'y' } });
    expect(r.ok === false && r.invalid).toEqual(['qty', 'unitPriceSen']);
  });

  it('demonstrates that the pre-existing clamp could not have caught this', () => {
    expect(Math.max(0, Number('abc') * 100 - 0)).toBeNaN();
  });

  it('does NOT reject negatives, which remain a separate open question', () => {
    const r = parseLineNumbers({ qty: { value: -2 }, unitPriceSen: { value: -50 } });
    expect(r).toEqual({ ok: true, nums: { qty: -2, unitPriceSen: -50 } });
  });
});

describe('invalidLineNumberBody', () => {
  it('names the offending fields in a plain-language sentence', () => {
    const b = invalidLineNumberBody(['qty', 'unitPriceSen']);
    expect(b.error).toBe('invalid_line_number');
    expect(b.fields).toEqual(['qty', 'unitPriceSen']);
    expect(b.reason).toBe('These line fields must be numbers: qty, unitPriceSen.');
  });
});
