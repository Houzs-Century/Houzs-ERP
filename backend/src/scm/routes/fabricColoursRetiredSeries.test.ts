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

const RETIRED = new Set(['FG66151', 'J9226', 'GARFIELD']);

describe('seriesIsRetired', () => {
  it('hides a colour whose series is switched off', () => {
    expect(seriesIsRetired(RETIRED, 'FG66151')).toBe(true);
    expect(seriesIsRetired(RETIRED, 'J9226')).toBe(true);
  });

  it('keeps a colour whose series is live', () => {
    expect(seriesIsRetired(RETIRED, 'BO315')).toBe(false);
    expect(seriesIsRetired(RETIRED, 'GD2034')).toBe(false);
  });

  it('trims BOTH sides — the padded twin must resolve to the same series', () => {
    /* Production holds the retired row as `GARFIELD ` and the colour
       GARFIELD-03 points at `GARFIELD `. Whichever side carries the space, the
       answer has to be the same, or a live fabric reads as retired depending on
       which row it met. The builder is what trims the library side, which is
       why it is used here rather than a hand-made Set. */
    const padded = retiredSeriesSet([{ id: 'GARFIELD ' }]);
    expect(seriesIsRetired(padded, 'GARFIELD')).toBe(true);
    expect(seriesIsRetired(padded, 'GARFIELD ')).toBe(true);
    expect(seriesIsRetired(retiredSeriesSet([{ id: ' GARFIELD ' }]), 'GARFIELD')).toBe(true);
  });

  it('the builder drops blank and missing ids rather than retiring everything', () => {
    const set = retiredSeriesSet([{ id: '  ' }, { id: null }, {}, { id: 'J9226' }]);
    expect([...set]).toEqual(['J9226']);
    expect(seriesIsRetired(set, '')).toBe(false);
  });

  it('the builder handles the real production shape', () => {
    const set = retiredSeriesSet([{ id: 'FG66151' }, { id: 'J9226' }, { id: 'GARFIELD ' }]);
    expect(set.size).toBe(3);
    expect(seriesIsRetired(set, 'GARFIELD')).toBe(true);
    expect(seriesIsRetired(set, 'BO315')).toBe(false);
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
