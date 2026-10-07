import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { invalidModelDefault, pickDefaultVariants } from './model-default-variants';

/* One rule, two readers: the Model PATCH gate and the line pickers. A browser
 * copy that drifted would pre-fill a default the save then refuses. */
describe('model-default-variants', () => {
  test('backend/src/scm/shared/model-default-variants.ts is byte-identical to this one', () => {
    const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');
    const there = norm('../backend/src/scm/shared/model-default-variants.ts');
    expect(there.length).toBeGreaterThan(500);
    expect(there).toBe(norm('src/vendor/shared/model-default-variants.ts'));
  });

  const ALLOWED = { divan_heights: ['10"', '12"'], gaps: ['4"'], leg_heights: [] };

  test('the SKU default beats the Model default; the Model fills the rest', () => {
    expect(pickDefaultVariants('BEDFRAME', { divanHeight: '10"', gap: '4"' }, { divanHeight: '12"' }, ALLOWED))
      .toEqual({ divanHeight: '12"', gap: '4"' });
  });

  test('a default the Model no longer allows is skipped, falling back to the other one', () => {
    expect(pickDefaultVariants('BEDFRAME', { divanHeight: '10"' }, { divanHeight: '14"' }, ALLOWED))
      .toEqual({ divanHeight: '10"' });
    expect(pickDefaultVariants('BEDFRAME', { gap: '6"' }, null, ALLOWED)).toEqual({});
  });

  test('an empty pool restricts nothing, and quote glyphs fold', () => {
    expect(pickDefaultVariants('bedframe', { legHeight: '2”', divanHeight: '10“' }, null, ALLOWED))
      .toEqual({ legHeight: '2”', divanHeight: '10“' });
  });

  test('only the category\'s own axes default (no fabric, no specials)', () => {
    expect(pickDefaultVariants('SOFA', { seatHeight: '24', fabricCode: 'BO315-23', gap: '4"' }, null, {}))
      .toEqual({ seatHeight: '24' });
    expect(pickDefaultVariants('ACCESSORY', { seatHeight: '24' }, null, {})).toEqual({});
  });

  test('the save gate names the first bad key', () => {
    expect(invalidModelDefault('BEDFRAME', { divanHeight: '12"' }, ALLOWED)).toBeNull();
    expect(invalidModelDefault('BEDFRAME', { divanHeight: '14"' }, ALLOWED)).toBe('divanHeight');
    expect(invalidModelDefault('BEDFRAME', { seatHeight: '24' }, ALLOWED)).toBe('seatHeight');
  });
});
