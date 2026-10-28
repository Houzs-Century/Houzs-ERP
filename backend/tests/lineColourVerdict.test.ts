import { describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs lib
import { buildFabricColourIndex } from '../scripts/lib/fabric-colour-match.mjs';
// @ts-expect-error — plain .mjs lib
import { lineColourVerdict } from '../scripts/lib/line-colour-verdict.mjs';

/* Texts copied from production SQUARE PILLOW / LONG PILLOW lines (plan run
   34843795061); library rows are real colour ids. */
const { explainColour } = buildFabricColourIndex([
  { fabric_id: 'MODENZA', colour_id: 'MODENZA-03', label: 'MODENZA-03', active: true },
  { fabric_id: 'COVE', colour_id: 'COVE-13', label: 'COVE-13', active: true },
  { fabric_id: 'BO315', colour_id: 'BO315-25', label: 'BO315-25 FOSSIL', active: true },
  { fabric_id: 'BO315', colour_id: 'BO315-27', label: 'BO315-27', active: true },
  { fabric_id: 'BO315', colour_id: 'BO315-28', label: 'BO315-28', active: true },
  { fabric_id: 'M2402', colour_id: 'M2402-15', label: 'M2402-15', active: true },
  { fabric_id: 'HR805', colour_id: 'HR805-31', label: 'HR805-31', active: true },
]);
const v = (t: string) => lineColourVerdict(t, explainColour);

describe('lineColourVerdict', () => {
  test.each([
    ['Col:Modenza 03', 'MODENZA-03'],
    ['Col : cove 13 | SPECIAL: Col : cove 13', 'COVE-13'],
    ['Col:B0315-25 | Col:B0315-25 |', 'BO315-25'],
    ['HR 805-31 |', 'HR805-31'],
  ])('%s -> %s', (text, code) => { expect(v(text)).toMatchObject({ verdict: 'match', code }); });

  test.each(['', 'TBC |', 'Col:kiv |', 'random Colour |', '{COL:TBC} |'])('no colour: %s', (t) => {
    expect(v(t).verdict).toBe('no-colour');
  });

  test('two colours on one line are never written', () => {
    expect(v('BO315-27 x2 BO315-28 x2').verdict).toBe('several');
    expect(v('x2Col:M2402-9/x2Col:M2402-15').verdict).toBe('several');
  });

  test('a named colour the library does not hold is unknown', () => {
    expect(v('Col:KN390-11 | Col:KN390-11 |').verdict).toBe('unknown');
  });
});
