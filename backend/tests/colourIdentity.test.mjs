/* The colour comparison, and the fourteen real rows it was built from.
 *
 * probe-link-identity.mjs reported "12 rows carry a colour that disagrees with
 * the line they were copied from" by comparing
 * coalesce(colourId, colourLabel, colourCode) — three different vocabularies.
 * probe-invoice-link-facts.mjs (run 34143079454, 2026-09-08 00:26 local)
 * printed all three fields on both sides for every one of them. NOT ONE was two
 * different fabrics.
 *
 * Every case below is a real pair from that run.
 */
import { describe, it, expect } from 'vitest';
import { compareColour, supersededBy, liveColourId, canonicalColour } from '../scripts/lib/colour-identity.mjs';

/* The fabric library as the run found it — the 2026-08-11 renumbering left the
   old rows in place with the pointer written into their own label. */
const LIB = new Map([
  ['CH141-8', 'CH141-8 [superseded by CH141-08 on 2026-08-11]'],
  ['CH141-08', 'CH141-08 ARMY'],
  ['BO315-5-FOSSIL', 'BO315-5-FOSSIL [superseded by BO315-05 on 2026-08-11]'],
  ['BO315-05', 'BO315-05 FOSSIL'],
  ['KS-01 BABY WHITE', 'BABY WHITE [superseded by KS-01 on 2026-08-11]'],
  ['KS-01', 'KS-01 BABY WHITE'],
  ['MODENZA-05', 'MODENZA-05 DARK OLIVE'],
  ['MODENZA-01', 'MODENZA-01 HOUSTON CREAM'],
  ['J9883-1-01', 'J9883-1-01'],
  ['GARFIELD-01', 'GARFIELD-01 SOFT LINEN'],
]);

describe('supersededBy', () => {
  it('reads the pointer the library writes into a dead row label', () => {
    expect(supersededBy('CH141-8 [superseded by CH141-08 on 2026-08-11]')).toBe('CH141-08');
    expect(supersededBy('CH141-08 ARMY')).toBeNull();
    expect(supersededBy(null)).toBeNull();
  });
  it('tolerates a pointer with no date', () => {
    expect(supersededBy('X [superseded by Y]')).toBe('Y');
  });
});

describe('liveColourId', () => {
  it('follows the supersession', () => {
    expect(liveColourId('CH141-8', LIB)).toBe('CH141-08');
    expect(liveColourId('CH141-08', LIB)).toBe('CH141-08');
  });
  it('does not loop forever on a library that points at itself', () => {
    const loop = new Map([['A', 'A [superseded by B]'], ['B', 'B [superseded by A]']]);
    expect(['A', 'B']).toContain(liveColourId('A', loop));
  });
});

describe('canonicalColour', () => {
  it('removes punctuation and case, and nothing else', () => {
    expect(canonicalColour('MODENZA 05- DARK OLIVE')).toBe(canonicalColour('MODENZA-05 DARK OLIVE'));
    /* It deliberately does NOT bridge zero-padding or a spelling difference. */
    expect(canonicalColour('J9883-1-1')).not.toBe(canonicalColour('J9883-1-01'));
    expect(canonicalColour('grafield1')).not.toBe(canonicalColour('garfield01'));
  });
});

describe('compareColour — the eight supersession pairs the probe found', () => {
  const same = (a, b) => compareColour(a, b, LIB);

  it('CH141-8 and CH141-08 are the same colour', () => {
    const r = same({ colourId: 'CH141-08', colourLabel: 'CH141-08 ARMY' }, { colourId: 'CH141-8' });
    expect(r.verdict).toBe('same');
    expect(r.why).toMatch(/supersession/);
  });

  it('BO315-5-FOSSIL and BO315-05 are the same colour', () => {
    expect(same({ colourId: 'BO315-05' }, { colourId: 'BO315-5-FOSSIL' }).verdict).toBe('same');
  });

  it('a row whose colourId IS the old label text still resolves', () => {
    expect(same({ colourId: 'KS-01 BABY WHITE' }, { colourId: 'KS-01' }).verdict).toBe('same');
  });
});

describe('compareColour — the six field-mixed pairs the probe found', () => {
  it('MODENZA 05- DARK OLIVE against colourId MODENZA-05 is the same colour', () => {
    const r = compareColour({ colourLabel: 'MODENZA 05- DARK OLIVE' }, { colourId: 'MODENZA-05' }, LIB);
    expect(r.verdict).toBe('same');
  });

  it('MODENZA 01- Houston Cream against colourId MODENZA-01 is the same colour', () => {
    expect(compareColour({ colourLabel: 'MODENZA 01- Houston Cream' }, { colourId: 'MODENZA-01' }, LIB).verdict).toBe('same');
  });

  /* THE TWO THIS MODULE REFUSES TO CALL EITHER WAY, and that is the point of
     the third verdict. `J9883-1-1 PAMA` is almost certainly `J9883-1-01` with
     the zero dropped, and `grafield1-softlinen` is almost certainly
     `GARFIELD-01 SOFT LINEN` with two letters transposed — but a string rule
     cannot PROVE either, and answering 'different' would send somebody to edit
     a row that is probably right. */
  it('J9883-1-1 PAMA against colourId J9883-1-01 is UNPROVEN, not different', () => {
    const r = compareColour({ colourLabel: 'J9883-1-1 PAMA' }, { colourId: 'J9883-1-01' }, LIB);
    expect(r.verdict).toBe('unproven');
    expect(r.why).toMatch(/has not measured a colour/);
  });

  it('grafield1-softlinen against colourId GARFIELD-01 is UNPROVEN, not different', () => {
    expect(compareColour({ colourLabel: 'grafield1-softlinen' }, { colourId: 'GARFIELD-01' }, LIB).verdict).toBe('unproven');
  });
});

describe('compareColour — what it WILL still call different', () => {
  /* The class must not become unable to fail, or it stops being a check. */
  it('two live colour ids that are different rows', () => {
    const r = compareColour({ colourId: 'MODENZA-05' }, { colourId: 'MODENZA-01' }, LIB);
    expect(r.verdict).toBe('different');
    expect(r.why).toMatch(/two live colour ids/);
  });

  it('an id whose supersession lands somewhere else entirely', () => {
    expect(compareColour({ colourId: 'CH141-8' }, { colourId: 'BO315-05' }, LIB).verdict).toBe('different');
  });
});
