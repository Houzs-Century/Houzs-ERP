// planQuoteNormalise — the PURE decision behind
// backend/scripts/normalise-maintenance-quotes.mjs.
//
// The interesting behaviour is the REFUSAL. Two pool entries that normalise
// onto the same key but price differently (supplier 07204b99's 19 inches, curly
// at RM120 and straight at RM40) must be reported and left alone: merging them
// would leave two identical keys whose lookup answer depends on array order —
// the ambiguity made permanent instead of removed.

// @ts-expect-error — plain .mjs module with no type declarations.
import { planQuoteNormalise, normaliseQuotes } from '../scripts/lib/maintenance-quote-normalise.mjs';
import { describe, it, expect } from 'vitest';

type Plan = {
  config: Record<string, unknown>;
  changes: Array<{ pool: string; from: string; to: string }>;
  collisions: Array<{ pool: string; value: string; detail: string }>;
};
const plan = (config: unknown): Plan => planQuoteNormalise(config) as Plan;

describe('normaliseQuotes', () => {
  it('mirrors the pricing engine — same characters, nothing else', () => {
    expect(normaliseQuotes('17“')).toBe('17"');
    expect(normaliseQuotes('25”')).toBe('25"');
    expect(normaliseQuotes('19″')).toBe('19"');
    expect(normaliseQuotes('  18" ')).toBe('  18" '); // no trim
  });
});

describe('planQuoteNormalise', () => {
  it('straightens curly values and reports each change', () => {
    const p = plan({ totalHeights: [{ value: '17“', priceSen: 12000 }, { value: '18"', priceSen: 8000 }] });
    expect((p.config.totalHeights as Array<{ value: string }>)[0].value).toBe('17"');
    expect(p.changes).toEqual([{ pool: 'totalHeights', from: '17“', to: '17"' }]);
    expect(p.collisions).toEqual([]);
  });

  it('keeps prices and every other field untouched', () => {
    const p = plan({ totalHeights: [{ value: '25”', priceSen: 4000, active: true, costSen: 111 }] });
    expect((p.config.totalHeights as Array<Record<string, unknown>>)[0])
      .toEqual({ value: '25"', priceSen: 4000, active: true, costSen: 111 });
  });

  it('REFUSES a pool where two spellings price differently, leaving it as-is', () => {
    const before = [{ value: '19“', priceSen: 12000 }, { value: '19"', priceSen: 4000 }];
    const p = plan({ totalHeights: before });
    expect(p.config.totalHeights).toBe(before); // same reference — untouched
    expect(p.changes).toEqual([]);
    expect(p.collisions).toHaveLength(1);
    expect(p.collisions[0].pool).toBe('totalHeights');
    expect(p.collisions[0].value).toBe('19"');
    expect(p.collisions[0].detail).toContain('12000');
    expect(p.collisions[0].detail).toContain('4000');
  });

  it('collapses a duplicate that prices the SAME — no conflict to resolve', () => {
    const p = plan({ totalHeights: [{ value: '18“', priceSen: 8000 }, { value: '18"', priceSen: 8000 }] });
    expect(p.collisions).toEqual([]);
    expect((p.config.totalHeights as Array<{ value: string }>).map((e) => e.value)).toEqual(['18"', '18"']);
  });

  it('refusing one pool does not block the others', () => {
    const p = plan({
      totalHeights: [{ value: '19“', priceSen: 12000 }, { value: '19"', priceSen: 4000 }],
      divanHeights: [{ value: '14“', priceSen: 15000 }],
    });
    expect(p.collisions).toHaveLength(1);
    expect((p.config.divanHeights as Array<{ value: string }>)[0].value).toBe('14"');
  });

  it('handles the bare-string pools (gaps, sizes) too', () => {
    const p = plan({ gaps: ['8“', '12"'] });
    expect(p.config.gaps).toEqual(['8"', '12"']);
    expect(p.changes).toEqual([{ pool: 'gaps', from: '8“', to: '8"' }]);
  });

  it('is a no-op on an already-clean config, and on junk', () => {
    const clean = { totalHeights: [{ value: '18"', priceSen: 8000 }] };
    const p = plan(clean);
    expect(p.changes).toEqual([]);
    expect(p.config.totalHeights).toBe(clean.totalHeights);
    expect(() => plan({})).not.toThrow();
    expect(() => plan(null)).not.toThrow();
  });
});
