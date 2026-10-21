import { describe, expect, it } from 'vitest';
import { needsNbSupplier } from './mrp-rule-supplier';

const NB = new Set(['NB-01', 'NB-04']);

describe('needsNbSupplier (HC-0128)', () => {
  it('fires on a Hydraulic special, any case, string or object form', () => {
    expect(needsNbSupplier({ specials: ['Divan Curve', 'Hydraulic'] }, NB)).toBe(true);
    expect(needsNbSupplier({ specials: ['hydraulic'] }, NB)).toBe(true);
    expect(needsNbSupplier({ specials: [{ code: 'HYDRAULIC' }] }, NB)).toBe(true);
    expect(needsNbSupplier({ special: ['Hydraulic'] }, NB)).toBe(true);
  });

  it('fires on hydraulic written only in the free-text add-on note (HC-SO-2610-161)', () => {
    expect(needsNbSupplier({ fabricCode: 'PC151-01', extraAddonNote: '12”divan no leg with hydraulic.' }, NB)).toBe(true);
  });

  it('fires on an NB-series fabric through the fabric code alias chain', () => {
    expect(needsNbSupplier({ fabricCode: 'NB-04' }, NB)).toBe(true);
    expect(needsNbSupplier({ fabricColor: 'nb-01' }, NB)).toBe(true);
  });

  it('does not fire on other fabrics, other specials or empty variants', () => {
    expect(needsNbSupplier({ fabricCode: 'PC151-01', specials: ['Right Drawer'] }, NB)).toBe(false);
    expect(needsNbSupplier({ fabricCode: 'NB-09' }, NB)).toBe(false);
    expect(needsNbSupplier({}, NB)).toBe(false);
    expect(needsNbSupplier(null, NB)).toBe(false);
  });
});
