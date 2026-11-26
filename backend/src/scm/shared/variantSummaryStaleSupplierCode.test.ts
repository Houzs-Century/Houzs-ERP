import { describe, expect, test } from 'vitest';
import { buildVariantSummary, withFabricSupplierCode } from './variant-summary';
import { variantsForCompare } from '../lib/amendment-noop-lines';

describe('supplier code stamp follows the fabric it was looked up for', () => {
  const ez002 = withFabricSupplierCode({ fabricCode: 'EZ-002', colourLabel: 'EZ-002 Sand', seatHeight: '28' }, 'M2402-4');

  test('a fresh stamp prints in parens', () => {
    expect(buildVariantSummary('sofa', ez002)).toContain('EZ-002 Sand (M2402-4)');
  });

  test('after the fabric changes, the old stamp does not print', () => {
    const amended = { ...ez002, fabricCode: 'EZ-011', colourLabel: 'EZ-011 Light Grey' };
    const summary = buildVariantSummary('sofa', amended);
    expect(summary).toContain('EZ-011 Light Grey');
    expect(summary).not.toContain('M2402-4');
  });

  test('a stamp saved without its fabric is not trusted', () => {
    const legacy = { fabricCode: 'EZ-011', colourLabel: 'EZ-011 Light Grey', fabricSupplierCode: 'M2402-4' };
    expect(buildVariantSummary('sofa', legacy)).not.toContain('M2402-4');
  });

  test('re-stamping the new fabric prints its own code', () => {
    const amended = withFabricSupplierCode({ ...ez002, fabricCode: 'EZ-011', colourLabel: 'EZ-011 Light Grey' }, 'M2402-18');
    expect(buildVariantSummary('sofa', amended)).toContain('EZ-011 Light Grey (M2402-18)');
  });

  test('the stamp is not a spec change for amendments', () => {
    const { fabricSupplierCode: _s, fabricSupplierCodeOf: _o, ...spec } = ez002;
    expect(variantsForCompare(ez002)).toBe(variantsForCompare(spec));
  });
});
