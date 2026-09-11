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

import { retiredByCode, retiredSeriesSet, seriesIsRetired } from './fabric-colours';

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

/* The same rule over fabric_trackings, which is keyed by id and NOT by code.
   21 codes on production carry TWO rows for one code: an active one beside a
   retired one, usually a plain id next to a `FABRIC_`-prefixed twin. The desktop
   picker asked per ROW and the dead twin hid the live fabric - 21 active colours
   hidden, ALL 21 wrongly - while the mobile sheet, which never filtered, showed
   them. That split is how the owner found it. Rows below are the production data
   verbatim. docs/bugs/0818. */
describe('retiredByCode - fabric_trackings', () => {
  const PROD = [
    { fabric_code: 'HR805-09', is_active: true },
    { fabric_code: 'HR805-10', is_active: true },
    { fabric_code: 'HR805-10', is_active: false },
    { fabric_code: 'HR805-90', is_active: true },
    { fabric_code: 'HR805-90', is_active: false },
    { fabric_code: 'GD2502-22', is_active: true },
  ];

  it('keeps a code that has ANY active row - the reported bug', () => {
    const set = retiredByCode(PROD, 'fabric_code', 'is_active');
    expect(seriesIsRetired(set, 'HR805-90')).toBe(false);
    expect(seriesIsRetired(set, 'HR805-10')).toBe(false);
    expect([...set]).toEqual([]);
  });

  it('retires a code whose every row is inactive', () => {
    const set = retiredByCode(
      [{ fabric_code: 'DEAD-01', is_active: false }, { fabric_code: 'DEAD-01', is_active: false }],
      'fabric_code', 'is_active',
    );
    expect(seriesIsRetired(set, 'DEAD-01')).toBe(true);
  });

  it('the per-ROW question is what was wrong, and this is the difference', () => {
    const perRow = new Set(PROD.filter((r) => r.is_active === false).map((r) => r.fabric_code));
    expect([...perRow].sort()).toEqual(['HR805-10', 'HR805-90']);
    expect([...retiredByCode(PROD, 'fabric_code', 'is_active')]).toEqual([]);
  });

  it('trims, and ignores blank codes', () => {
    const set = retiredByCode(
      [{ fabric_code: ' DEAD-02 ', is_active: false }, { fabric_code: '', is_active: false }],
      'fabric_code', 'is_active',
    );
    expect([...set]).toEqual(['DEAD-02']);
  });

  it('anything other than true reads as inactive, so a missing flag cannot un-retire', () => {
    const set = retiredByCode([{ fabric_code: 'X' }, { fabric_code: 'X', is_active: null }], 'fabric_code', 'is_active');
    expect(seriesIsRetired(set, 'X')).toBe(true);
  });

  it('retiredSeriesSet is the same rule over id + active', () => {
    expect([...retiredSeriesSet([{ id: 'GARFIELD', active: true }, { id: 'GARFIELD ', active: false }])]).toEqual([]);
  });
});
