/* docs/bugs/0893 (the fabric-search entry) — every on-offer rule runs BEFORE
   the typeahead cap.

   The cap used to live in the query (`.limit(50)`) and the retired-series,
   retired-code and (client-side) Model-pool rules ran on what it let through.
   A search whose first 50 matches were retired or outside the Model's pool came
   back short or empty, while matching colours further down were never read: the
   "I cannot find the fabric" shape of 0814, 0816 and 0818, which the owner
   reported more than once. These cases pin the order: rules first, cap last. */
import { describe, expect, it } from 'vitest';

import { OFFER_SCAN_ROWS, coloursOnOffer } from './fabric-colours';

const row = (colour: string, series: string) => ({ colour_id: colour, fabric_id: series });
const none = new Set<string>();

describe('coloursOnOffer — rules first, cap last', () => {
  it('a colour past the first 50 matches is still offered when the 50 ahead of it are retired', () => {
    const retired = Array.from({ length: 50 }, (_, i) => row(`FG66151-${i}`, 'FG66151'));
    const live = Array.from({ length: 10 }, (_, i) => row(`BO315-${i}`, 'BO315'));
    const out = coloursOnOffer([...retired, ...live], { retiredSeries: new Set(['FG66151']), retiredCodes: none, pool: null }, 50);
    expect(out.map((r) => r.colour_id)).toEqual(live.map((r) => r.colour_id));
  });

  it('the same for colours outside the Model pool ahead of allowed ones', () => {
    const outside = Array.from({ length: 55 }, (_, i) => row(`GD2502-${i}`, 'GD2502'));
    const allowed = [row('BO315-01', 'BO315'), row('CG-002-11', 'CG-002')];
    const out = coloursOnOffer([...outside, ...allowed], { retiredSeries: none, retiredCodes: none, pool: ['BO315', 'CG-002-11'] }, 50);
    expect(out.map((r) => r.colour_id)).toEqual(['BO315-01', 'CG-002-11']);
  });

  it('a retired fabric CODE is dropped before the cap too', () => {
    const dead = Array.from({ length: 50 }, () => row('HR805-90', 'HR805'));
    const out = coloursOnOffer([...dead, row('HR805-10', 'HR805')], { retiredSeries: none, retiredCodes: new Set(['HR805-90']), pool: null }, 50);
    expect(out.map((r) => r.colour_id)).toEqual(['HR805-10']);
  });

  it('the cap still holds once the rules have run', () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`BO315-${i}`, 'BO315'));
    expect(coloursOnOffer(many, { retiredSeries: none, retiredCodes: none, pool: null }, 50)).toHaveLength(50);
  });

  it('a null cap is the full list, unchanged', () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`BO315-${i}`, 'BO315'));
    expect(coloursOnOffer(many, { retiredSeries: none, retiredCodes: none, pool: null }, null)).toHaveLength(120);
  });

  it('an empty pool restricts nothing', () => {
    const rows = [row('GD2502-11', 'GD2502'), row('BO315-23', 'BO315')];
    expect(coloursOnOffer(rows, { retiredSeries: none, retiredCodes: none, pool: [] }, 50)).toHaveLength(2);
  });

  it('reads the camelCase shape as well as the snake_case one', () => {
    const rows = [{ colourId: 'BO315-23', fabricId: 'BO315' }, { colourId: 'GD2502-11', fabricId: 'GD2502' }];
    expect(coloursOnOffer(rows, { retiredSeries: none, retiredCodes: none, pool: ['BO315'] }, 50)).toEqual([rows[0]]);
  });

  it('scans the PostgREST page, not the typeahead cap', () => {
    expect(OFFER_SCAN_ROWS).toBe(1000);
  });
});
