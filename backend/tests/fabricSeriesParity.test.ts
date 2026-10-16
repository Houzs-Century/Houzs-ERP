import { describe, expect, test } from 'vitest';
import { seriesOf } from '../src/scm/routes/fabric-tracking';
// @ts-expect-error - plain .mjs, shared by every fabric repair script
import { parse } from '../scripts/lib/fabric-code.mjs';

/* The route mirrors a new fabric code into the selling library under a SERIES,
   and the POS picker groups colours by that series. The repair scripts derive
   the series with scripts/lib/fabric-code.mjs. The two drifted: the route had
   no rule for a code without a separator, so "KN01" became series KN01 and the
   KN range showed as six one-chip groups instead of one KN group. */

describe('the route and the scripts agree on a fabric series', () => {
  const corpus = [
    'KN01', 'KN02', 'KN12', 'NB01', 'kn05',
    'HG1313-01', 'HG1313-13', 'AM275-02', 'SF-AT-01', 'ALPINE-5311-13',
    'J9226-01', 'KN390-1', 'CG-002', 'EZ-14',
  ];
  test.each(corpus)('%s', (code) => {
    expect(seriesOf(code)).toBe(parse(code).series);
  });

  test('the whole KN range lands in one series', () => {
    expect(new Set(['KN01', 'KN02', 'KN04', 'KN05', 'KN10', 'KN12'].map(seriesOf))).toEqual(new Set(['KN']));
  });

  test('a glued tail longer than two digits is not split', () => {
    expect(seriesOf('PU1910')).toBe('PU1910');
    expect(seriesOf('FG6876')).toBe('FG6876');
  });
});
