import { describe, it, expect } from 'vitest';
import { nonFabricCodeWord } from './fabric-tracking';

/* The Fabric Converter's two write paths (POST / and POST /bulk-upsert) take
   whatever string arrives as `fabricCode`. That is how "SOFA 5535" and
   "SQUARE PILLOW" reached scm.fabric_trackings in the wholesale copy of the
   HOOKKA fabric master (backend/_hk.json, 2026-06-23) and sat there until the
   2026-08-13 probe.

   These pin BOTH halves of the guard, because the second half is the one that
   would do real damage: the codes below marked "real" are taken verbatim from
   that same 153-row master and from the catalogue the owner dictated on
   2026-08-11, and every one of them has to keep passing. */

describe('nonFabricCodeWord — the two rows the prod probe found', () => {
  it('refuses the product codes the owner asked about', () => {
    expect(nonFabricCodeWord('SOFA 5535')).toBe('SOFA');
    expect(nonFabricCodeWord('SQUARE PILLOW')).toBe('SQUARE PILLOW');
  });

  it('refuses them however the sheet spaced or cased them', () => {
    expect(nonFabricCodeWord('  sofa 5535 ')).toBe('SOFA');
    expect(nonFabricCodeWord('Square  Pillow')).toBe('SQUARE PILLOW');
  });

  it('refuses the rest of the product vocabulary at the head of a code', () => {
    expect(nonFabricCodeWord('LONG PILLOW')).toBe('LONG PILLOW');
    expect(nonFabricCodeWord('BOLSTER 20"')).toBe('BOLSTER');
    expect(nonFabricCodeWord('MATTRESS-(Q)')).toBe('MATTRESS');
    expect(nonFabricCodeWord('DIVAN ONLY-(K)')).toBe('DIVAN');
    expect(nonFabricCodeWord('DELIVERY CHARGE')).toBe('DELIVERY');
  });
});

describe('nonFabricCodeWord — what it must never refuse', () => {
  /* Nine rows of the real fabric master describe themselves this way. A guard
     that read the DESCRIPTION instead of the code would have refused all nine
     genuine Koona velvets to catch the two products — the trade this rule
     exists to avoid. The guard only ever sees a CODE, and the code is fine. */
  it('judges the code, never the description — "SOFA FABRIC KOONA VELVET PEARL" is KN390-1', () => {
    expect(nonFabricCodeWord('KN390-1')).toBeNull();
    expect(nonFabricCodeWord('KN390-14')).toBeNull();
  });

  it('accepts every shape the real fabric catalogue uses', () => {
    for (const code of [
      // seeded collections (migration 0022)
      'CG-001', 'EZ-012', 'BF-01',
      // the owner's 2026-08-11 catalogue
      'ZL-03', 'MODENZA-01', 'BO315-27', 'NX016', 'GD2502-04', 'AM275-02',
      'CH141-14', 'M2402-19', 'ORION-5', 'TR1', 'DE22', 'HR805-90',
      // the awkward real ones: a space, a brand prefix, brackets, a bare name
      'AM 275-7', 'GARFIELD - 3 TUNDORA', 'FABR(W) B', 'TARONI - CREAM',
      'PESTO-PT004', 'NINJA 06', 'SL0095', 'KS-01', 'SF-AT-15',
      'UNMATCHED-PICCO-FG66151-11', 'FABRIC HR805-10',
    ]) {
      expect(nonFabricCodeWord(code), code).toBeNull();
    }
  });

  it('matches a whole word, so a fabric that merely starts with those letters passes', () => {
    expect(nonFabricCodeWord('SOFAR-01')).toBeNull();
    expect(nonFabricCodeWord('CONSOLETTE-2')).toBeNull();
    expect(nonFabricCodeWord('STOOLEY 04')).toBeNull();
    expect(nonFabricCodeWord('SERVICEABLE-1')).toBeNull();
  });

  it('only looks at the head — a product word deeper in a code is not the same claim', () => {
    expect(nonFabricCodeWord('KN390-2 SOFA')).toBeNull();
    expect(nonFabricCodeWord('')).toBeNull();
  });
});
