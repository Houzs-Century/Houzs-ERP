// A colour of a DISCONTINUED fabric is not on offer — owner 2026-09-11,
// 「inactive的就不需要了」.
//
// `fabric_colours.active` is the colour's own flag and this route always
// honoured it. Nothing on the selling path read the SERIES' flag
// (`fabric_library.active`), so a fabric switched off in the library kept
// offering every shade. MEASURED on production that day, company 1: 32 active
// colours belong to a discontinued series — FG66151 (17), J9226 (14) and
// `GARFIELD ` (1). They were invisible only because no sofa Model happened to
// list those series.
//
// The values below are that production data verbatim, including the whitespace
// twin: the library holds BOTH `GARFIELD` (active) and `GARFIELD ` (retired),
// and the colour `GARFIELD-03` points at the padded one.
import { describe, expect, it } from 'vitest';

import { retiredSeriesSet, seriesIsRetired } from './fabric-colours';

const RETIRED = new Set(['FG66151', 'J9226']);

describe('seriesIsRetired', () => {
  it('hides a colour whose series is switched off', () => {
    expect(seriesIsRetired(RETIRED, 'FG66151')).toBe(true);
    expect(seriesIsRetired(RETIRED, 'J9226')).toBe(true);
  });

  it('keeps GARFIELD, which the shipped regression hid', () => {
    expect(seriesIsRetired(RETIRED, 'GARFIELD')).toBe(false);
  });

  it('keeps a colour whose series is live', () => {
    expect(seriesIsRetired(RETIRED, 'BO315')).toBe(false);
    expect(seriesIsRetired(RETIRED, 'GD2034')).toBe(false);
  });

  /* THE REGRESSION THIS FILE SHIPPED, kept as the first case so it cannot come
     back. An earlier builder took only the INACTIVE rows and trimmed them, so
     the retired `GARFIELD ` trimmed onto the LIVE `GARFIELD` and switched it
     off - nine colours a customer buys, measured gone minutes after deploy. A
     LIVE row must win over a retired twin, so the question is per CODE. */
  it('a LIVE row wins over a retired padded twin — the regression', () => {
    const set = retiredSeriesSet([
      { id: 'GARFIELD', active: true },
      { id: 'GARFIELD ', active: false },
    ]);
    expect(seriesIsRetired(set, 'GARFIELD')).toBe(false);
    expect(seriesIsRetired(set, 'GARFIELD ')).toBe(false);
  });

  it('retires the code when EVERY row for it is inactive, padded or not', () => {
    const set = retiredSeriesSet([{ id: 'J9226', active: false }, { id: 'J9226 ', active: false }]);
    expect(seriesIsRetired(set, 'J9226')).toBe(true);
    expect(seriesIsRetired(set, 'J9226 ')).toBe(true);
  });

  it('trims BOTH sides, so a padded value still resolves to its code', () => {
    const set = retiredSeriesSet([{ id: 'FG66151', active: false }]);
    expect(seriesIsRetired(set, ' FG66151 ')).toBe(true);
  });

  it('the builder drops blank and missing ids rather than retiring everything', () => {
    const set = retiredSeriesSet([{ id: '  ', active: false }, { id: null, active: false }, {}, { id: 'J9226', active: false }]);
    expect([...set]).toEqual(['J9226']);
    expect(seriesIsRetired(set, '')).toBe(false);
  });

  it('the builder handles the real production shape', () => {
    /* Verbatim from production 2026-09-11: two retired series, plus GARFIELD's
       live row and its retired padded twin. */
    const set = retiredSeriesSet([
      { id: 'FG66151', active: false },
      { id: 'J9226', active: false },
      { id: 'GARFIELD ', active: false },
      { id: 'GARFIELD', active: true },
      { id: 'TARONI', active: true },
      { id: 'TARONI ', active: true },
      { id: 'BO315', active: true },
    ]);
    expect([...set].sort()).toEqual(['FG66151', 'J9226']);
    expect(seriesIsRetired(set, 'GARFIELD')).toBe(false);
    expect(seriesIsRetired(set, 'TARONI ')).toBe(false);
    expect(seriesIsRetired(set, 'BO315')).toBe(false);
  });

  it('anything other than active===true reads as inactive, so a missing flag cannot silently un-retire', () => {
    expect(seriesIsRetired(retiredSeriesSet([{ id: 'X' }]), 'X')).toBe(true);
    expect(seriesIsRetired(retiredSeriesSet([{ id: 'X', active: null }]), 'X')).toBe(true);
  });

  it('a blank or missing series is NOT retired — it cannot be proven to be', () => {
    for (const v of ['', '   ', null, undefined]) {
      expect(seriesIsRetired(RETIRED, v)).toBe(false);
    }
  });

  it('an EMPTY retired set hides nothing, so an unreadable library degrades to the old behaviour', () => {
    expect(seriesIsRetired(new Set(), 'FG66151')).toBe(false);
  });

  it('matches the whole series, never a prefix — J9226 must not retire J92260', () => {
    expect(seriesIsRetired(RETIRED, 'J92260')).toBe(false);
    expect(seriesIsRetired(RETIRED, 'FG6615')).toBe(false);
  });

  it('is case SENSITIVE, because a fabric code is an identifier', () => {
    // The library and the colour rows are written by the same import, so the
    // casing agrees. Folding case here would start matching two codes that the
    // catalogue deliberately keeps apart.
    expect(seriesIsRetired(RETIRED, 'fg66151')).toBe(false);
  });
});
