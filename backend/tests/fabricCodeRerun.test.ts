import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared by every fabric repair script
import { parse, canonId, canonLabel, nameFromLabel, stripNote } from '../scripts/lib/fabric-code.mjs';

/* THE SECOND RUN MUST NOT ERASE THE COLOUR NAME.

   normalize-fabric-codes.mjs rebuilds a colour's label from the name it parses
   out of the CODE. Before 2026-08-11 the name lived in the code ("J9226-1
   SAND"), so run one produced code "J9226-01" / label "J9226-01 SAND". Run two
   parses a now-clean code, finds NO name there, and - until 2026-08-13 -
   rewrote the label to a bare "J9226-01". A production PLAN on 2026-08-13
   proposed 200 such rewrites, every one deleting a colour name with the code
   unchanged. Caught before apply.

   The fix is nameFromLabel: the label the first run wrote is a name SOURCE for
   every run after it. These cases are the contract. */

/* This mirrors the winner-name choice in normalize-fabric-codes.mjs: the code
   first, then the label, then any sibling in the merge group. */
const nameOf = (colourId: string, label: string) =>
  parse(colourId)?.name || nameFromLabel(colourId, label);

const rebuild = (colourId: string, label: string) => {
  const p = parse(colourId);
  if (!p) return null;
  const target = { ...p, name: nameOf(colourId, label) };
  return { id: canonId(target), label: canonLabel(target) };
};

describe('a second normalisation pass is inert', () => {
  test.each([
    ['J9226-01', 'J9226-01 SAND'],
    ['BO315-04', 'BO315-04 SAND'],
    ['MODENZA-01', 'MODENZA-01 HOUSTON CREAM'],
    ['NOVENA-1003', 'NOVENA-1003 PEARL'],
    ['SF-AT-01', 'SF-AT-01 TOAST ALMOND'],
  ])('%s keeps its name', (code, label) => {
    const out = rebuild(code, label)!;
    expect(out.id).toBe(code);
    expect(out.label).toBe(label);
  });

  test('the FIRST pass still moves the name out of the code', () => {
    // "J9226-1 SAND" is the pre-2026-08-11 shape: brand off, name in the code.
    const out = rebuild('J9226-1 SAND', 'J9226-1 SAND')!;
    expect(out.id).toBe('J9226-01');
    expect(out.label).toBe('J9226-01 SAND');
    // and running the result through again changes nothing
    expect(rebuild(out.id, out.label)).toEqual(out);
  });

  test('a code with no name anywhere stays name-less', () => {
    expect(rebuild('BO315-11', 'BO315-11')).toEqual({ id: 'BO315-11', label: 'BO315-11' });
  });
});

describe('a label may only donate a name to its OWN colour', () => {
  test('a label naming a different colour is refused', () => {
    expect(nameFromLabel('BO315-04', 'BO315-05 SAND')).toBeNull();
    expect(nameFromLabel('BO315-04', 'NOVENA-04 SAND')).toBeNull();
  });

  test('a label that is not a code at all donates nothing', () => {
    expect(nameFromLabel('BO315-11', 'METAL')).toBeNull();
    expect(nameFromLabel('BO315-24', 'FABRIC')).toBeNull();
    expect(nameFromLabel('BO315-11', '')).toBeNull();
    expect(nameFromLabel('BO315-11', null)).toBeNull();
  });

  test('a digits-only tail is a cut number, never a name', () => {
    // the NOVENA-1003 failure, seen from the label side
    expect(nameFromLabel('NOVENA-100', 'NOVENA-100 3')).toBeNull();
  });
});

describe('the supersede stamp is bookkeeping, not a colour name', () => {
  test('stripNote cuts it off', () => {
    expect(stripNote('BO315-2-FEATHER [MERGED into BO315-02 on 2026-08-11 - superseded, not deleted]'))
      .toBe('BO315-2-FEATHER');
    expect(stripNote('J9226-01 SAND [superseded by J9226-02 on 2026-08-11]')).toBe('J9226-01 SAND');
    expect(stripNote('J9226-01 SAND')).toBe('J9226-01 SAND');
  });

  test('a stamped label never turns the stamp into the name', () => {
    const name = nameFromLabel('J9226-01', 'J9226-01 SAND [superseded by J9226-02 on 2026-08-11]');
    expect(name).toBe('SAND');
  });
});
