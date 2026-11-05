import { describe, it, expect } from 'vitest';
import { compartmentsWithoutSku } from './product-models';
import { checkAllowedOptions } from '../lib/allowed-options-check';

/* HC-0176 (2026-10-29): `9050-CONSOLE WOODEN` (imported 2026-10-15, bound to
   HOOKKA) could not go on an SO because the 9050 ENZO Model's compartment list
   only names `Console`. The fix is ticking "Console Wooden" (the Maintenance
   pool's spelling) on the Model — which, with an exact-case existence check,
   also minted a twin `9050-Console Wooden`. */

const enzoPool = [
  '1A(LHF)', '1A(RHF)', '1B(LHF)', '1B(RHF)', '1NA', '1S', '2A(LHF)', '2A(RHF)',
  '2B(LHF)', '2B(RHF)', '2NA', '2S', 'CNR', 'L(LHF)', 'L(RHF)', 'STOOL', '3S', 'Console',
];
const wooden = { code: '9050-CONSOLE WOODEN', category: 'SOFA', model_id: 'enzo', size_code: null };
const enzo = (compartments: string[]) =>
  ({ id: 'enzo', allowed_options: { compartments } }) as Parameters<typeof checkAllowedOptions>[1];

describe('HC-0176 — 9050 ENZO console with wooden', () => {
  it('is refused while the Model lists only Console', () => {
    expect(checkAllowedOptions(wooden, enzo(enzoPool), null)).toMatchObject({
      error: 'variant_not_allowed', field: 'compartment', value: 'CONSOLE WOODEN',
    });
  });

  it('is accepted once the Model ticks the pool entry "Console Wooden"', () => {
    expect(checkAllowedOptions(wooden, enzo([...enzoPool, 'Console Wooden']), null)).toBeNull();
  });

  it('ticking it does not create a second SKU that differs only in case', () => {
    const existing = ['9050-Console', '9050-CONSOLE', '9050-CONSOLE WOODEN'];
    expect(compartmentsWithoutSku(['Console Wooden'], '9050', existing)).toEqual([]);
  });

  it('still creates the SKU for a compartment that has none', () => {
    expect(compartmentsWithoutSku(['Console Wooden', '1ABOX(LHF)'], '9050', ['9050-CONSOLE WOODEN']))
      .toEqual(['1ABOX(LHF)']);
  });
});
