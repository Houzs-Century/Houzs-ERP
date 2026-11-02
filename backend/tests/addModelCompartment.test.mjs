/**
 * The rules behind scripts/add-model-compartment.mjs, pinned. Adding one sofa
 * compartment to a Model must: keep the pool entry's casing (the engine matches
 * case-sensitively), mint `<MODEL>-<comp>` / `SOFA <NAME> <comp>` exactly as the
 * Modular picker does, leave every other pool untouched, and do nothing on a
 * second run. The runner's own three writes are plan/apply/verify around these
 * pure transforms, so pinning them here is pinning the decision.
 */
import { describe, it, expect } from 'vitest';

import {
  normalizeCode, skuCodeFor, skuNameFor, itemCodeTooLong,
  arrayWith, poolWithCompartment, optionsWithCompartment,
} from '../scripts/lib/add-model-compartment.mjs';

describe('add-model-compartment transforms', () => {
  it('normalizeCode trims and tolerates absent input', () => {
    expect(normalizeCode('  G1F ')).toBe('G1F');
    expect(normalizeCode(undefined)).toBe('');
  });

  it('sku code and name mirror the Modular picker format', () => {
    expect(skuCodeFor('7233', 'G1F')).toBe('7233-G1F');
    expect(skuCodeFor('adda', 'G1F')).toBe('ADDA-G1F'); // model uppercased
    expect(skuNameFor('7233', '7233', 'G1F')).toBe('SOFA 7233 G1F');
    expect(skuNameFor('', '7233', 'G1F')).toBe('SOFA 7233 G1F'); // name falls back to code
    expect(skuNameFor('ADDA', '7233', 'G1F')).toBe('SOFA ADDA G1F');
  });

  it('gates the 30-character item-code limit', () => {
    expect(itemCodeTooLong('7233', 'G1F')).toBe(false);
    expect(itemCodeTooLong('7233', 'A'.repeat(25))).toBe(false); // 7233- + 25 = 30
    expect(itemCodeTooLong('7233', 'A'.repeat(26))).toBe(true); // = 31
  });

  it('arrayWith appends once, case-sensitively', () => {
    expect(arrayWith(['1S'], 'G1F')).toEqual({ list: ['1S', 'G1F'], added: true });
    expect(arrayWith(['1S', 'G1F'], 'G1F')).toEqual({ list: ['1S', 'G1F'], added: false });
    // Different casing is a different code — never silently folded together.
    expect(arrayWith(['G1F'], 'g1f')).toEqual({ list: ['G1F', 'g1f'], added: true });
    expect(arrayWith(undefined, 'G1F')).toEqual({ list: ['G1F'], added: true });
  });

  it('poolWithCompartment keeps every other pool and is idempotent', () => {
    const cfg = { sizes: ['24'], sofaCompartments: ['1S'], fabrics: ['x'] };
    const { config, added } = poolWithCompartment(cfg, 'G1F');
    expect(added).toBe(true);
    expect(config.sofaCompartments).toEqual(['1S', 'G1F']);
    expect(config.sizes).toEqual(['24']); // untouched
    expect(config.fabrics).toEqual(['x']); // untouched
    expect(poolWithCompartment(config, 'G1F').added).toBe(false);
    // A config with no compartment pool yet gets a one-element array.
    expect(poolWithCompartment({ sizes: ['24'] }, 'G1F').config.sofaCompartments).toEqual(['G1F']);
    // A missing config is treated as empty, never a crash.
    expect(poolWithCompartment(null, 'G1F').config.sofaCompartments).toEqual(['G1F']);
  });

  it('optionsWithCompartment keeps every other option pool and is idempotent', () => {
    const opts = { sizes: ['24'], compartments: ['1S'], leg_heights: ['4"'] };
    const { options, added } = optionsWithCompartment(opts, 'G1F');
    expect(added).toBe(true);
    expect(options.compartments).toEqual(['1S', 'G1F']);
    expect(options.leg_heights).toEqual(['4"']); // untouched
    expect(optionsWithCompartment(options, 'G1F').added).toBe(false);
    // A missing options object is treated as empty, never a crash.
    expect(optionsWithCompartment(null, 'G1F').options.compartments).toEqual(['G1F']);
  });
});
