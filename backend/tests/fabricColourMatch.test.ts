import { describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs lib
import { fabricKey, indexFabricMaster, matchFabricColour } from '../scripts/lib/fabric-colour-match.mjs';

/* The colour texts below are copied from production lines of SQUARE PILLOW /
   LONG PILLOW (probe run 34840903428), and the master rows are real codes. */
const master = indexFabricMaster([
  { fabric_code: 'MODENZA-03' }, { fabric_code: 'MODENZA-04' }, { fabric_code: 'COVE-03' }, { fabric_code: 'COVE-13' },
  { fabric_code: 'BO315-25' }, { fabric_code: 'BO315-32' }, { fabric_code: 'BO315-4-SAND' }, { fabric_code: 'GD2502-14' },
  { fabric_code: 'HR805-31' }, { fabric_code: 'CH141-5-PEARL' }, { fabric_code: 'NX007' }, { fabric_code: 'GD8371-02' },
  { fabric_code: 'M2402-13' }, { fabric_code: 'M2402-13-FOREST', uses: 5 }, { fabric_code: 'M2402-15' }, { fabric_code: 'M2402-1-PEARL' },
  { fabric_code: 'CH141-08', uses: 1 }, { fabric_code: 'CH141-8-ARMY', uses: 1 },
  { fabric_code: 'CH141-12', is_active: false }, { fabric_code: 'CH141-12-METAL' },
]);
const m = (t: string) => matchFabricColour(t, master);

describe('fabricKey', () => {
  test('a descriptive tail and leading zeros are not part of the key', () => {
    expect(fabricKey('CH141-8-ARMY')).toBe(fabricKey('CH141-08'));
    expect(fabricKey('MODENZA-04')).toBe('MODENZA|4');
  });
  test('a zero typed for the letter O reads as the same code', () => {
    expect(fabricKey('B0315-25')).toBe(fabricKey('BO315-25'));
  });
});

describe('matchFabricColour — real production texts', () => {
  test.each([
    ['Col:Modenza 03', 'MODENZA-03'],
    ['MODENZA-04 (MUSTARD) | MODENZA-04 (MUSTARD)', 'MODENZA-04'],
    ['Col : cove 13 | SPECIAL: Col : cove 13', 'COVE-13'],
    ['Col : cove -03', 'COVE-03'],
    ['Col:B0315-25 | Col:B0315-25 |', 'BO315-25'],
    ['COL: BO315-32 DEEP GREY', 'BO315-32'],
    ['BO315-4 (SAND)', 'BO315-4-SAND'],
    ['colour : GD2502#14- silver', 'GD2502-14'],
    ['HR 805-31 |', 'HR805-31'],
    ['CH141-5 (PEARL) | CH141-5 (PEARL) |', 'CH141-5-PEARL'],
    ['Col:NX007 Lilac', 'NX007'],
    ['COL: BEETEX HARRING GD8371 02# BEIGE', 'GD8371-02'],
    ['{COL:M2402-1 Pearl}', 'M2402-1-PEARL'],
  ])('%s -> %s', (text, code) => {
    expect(m(text)).toMatchObject({ verdict: 'match', code });
  });

  test.each(['16 X 16 / COL : TBC |', 'TBC |', 'Col: |', 'random |', 'Col:kiv |', '{COL:TBC} |', '', '16x16/col: TBC |', 'FREE · Lucky Draw'])(
    'no colour: %s', (text) => { expect(m(text).verdict).toBe('no-colour'); },
  );

  test('a two-colour line is not guessed', () => {
    expect(m('x2Col:M2402-9/x2Col:M2402-15').verdict).not.toBe('match');
    expect(m('BO315-27 x2 BO315-32 x2').verdict).toBe('several');
  });

  test('a code the master does not hold is unknown, not the nearest code', () => {
    expect(m('COL: J9883-1-1 pama').verdict).toBe('unknown');
  });

  test('a colour held twice: most-used wins, a tie is refused, an inactive twin loses', () => {
    expect(m('M2402-13 (FOREST)')).toMatchObject({ verdict: 'match', code: 'M2402-13-FOREST' });
    expect(m('CH141-08 (ARMY)').verdict).toBe('duplicate');
    expect(m('CH141-12 Metal')).toMatchObject({ verdict: 'match', code: 'CH141-12-METAL' });
  });

  test('a code number inside another is not matched as the shorter one', () => {
    expect(m('Col:M2402-15')).toMatchObject({ verdict: 'match', code: 'M2402-15' });
  });
});

describe('a family that ends in O', () => {
  const idx = indexFabricMaster([{ fabric_code: 'CHINO-01' }, { fabric_code: 'BO315-8' }]);
  test('CHINO-01 meets its own master row however it is typed', () => {
    expect(matchFabricColour('COL:CHINO-01', idx)).toMatchObject({ verdict: 'match', code: 'CHINO-01' });
    expect(matchFabricColour('Col:CHINO 1', idx)).toMatchObject({ verdict: 'match', code: 'CHINO-01' });
  });
  test('B0315-8 still meets BO315-8', () => {
    expect(matchFabricColour('colour : B0315-8', idx)).toMatchObject({ verdict: 'match', code: 'BO315-8' });
  });
});
