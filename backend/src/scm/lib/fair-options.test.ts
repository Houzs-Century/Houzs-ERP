import { describe, it, expect } from 'vitest';
import {
  buildFairOptions,
  resolveFair,
  fairOptionLabel,
  isPickableFair,
  periodContains,
  type FairProjectRow,
} from './fair-options';

/* ---------------------------------------------------------------------------
 * The fair picker decides which exhibition a sale is attributed to — which
 * fair's P&L it lands in and whose commission it pays. These tests are the
 * specification of the owner's 2026-09-13 rules, including the ones that assert
 * the resolver REFUSES to answer rather than guess.
 *
 * The data in these cases is real: the MID VALLEY / REX rows are projects
 * 340/341/342/2250 as they stood on production on 2026-09-13, and the
 * MVEC SOUTHKEY / REX pair is the August double-booking that is the ONLY reason
 * a date ever appears on a row.
 * ------------------------------------------------------------------------- */

const fair = (o: Partial<FairProjectRow> & { projectId: number }): FairProjectRow => ({
  venue: 'MID VALLEY',
  organizer: 'REX',
  brand: 'AKEMI',
  startDate: '2026-09-11',
  endDate: '2026-09-13',
  status: 'confirmed',
  ...o,
});

/* The four brand booths that were live at MID VALLEY on 13 Sep 2026. */
const MID_VALLEY_REX: FairProjectRow[] = [
  fair({ projectId: 340, brand: 'AKEMI' }),
  fair({ projectId: 341, brand: 'ZANOTTI' }),
  fair({ projectId: 342, brand: 'ERGOTEX' }),
  fair({ projectId: 2250, brand: 'ERGOTEX' }), // the duplicate record of 342
];

describe('buildFairOptions — one row is a place plus an organizer', () => {
  it('collapses every brand booth at one event into a SINGLE row', () => {
    const { running } = buildFairOptions(MID_VALLEY_REX, '2026-09-13');
    expect(running).toHaveLength(1);
    expect(running[0].venue).toBe('MID VALLEY');
    expect(running[0].organizer).toBe('REX');
    expect(running[0].projectIds).toEqual([340, 341, 342, 2250]);
  });

  it('labels a row with no dates — the owner picks event and organizer only', () => {
    const { running } = buildFairOptions(MID_VALLEY_REX, '2026-09-13');
    expect(fairOptionLabel(running[0])).toBe('MID VALLEY — REX');
    expect(running[0].showDates).toBe(false);
  });

  it('splits running-today from the rest of the month', () => {
    const rows = [
      ...MID_VALLEY_REX,
      fair({ projectId: 2258, venue: 'THE COMMUNE KULAI', organizer: 'INHOME' }),
      fair({ projectId: 346, venue: 'MVEC SOUTHKEY', organizer: 'MLE', startDate: '2026-09-18', endDate: '2026-09-20' }),
      fair({ projectId: 361, venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: 'BIGHOME', startDate: '2026-09-04', endDate: '2026-09-06' }),
    ];
    const { running, month } = buildFairOptions(rows, '2026-09-13');
    expect(running.map((o) => o.venue)).toEqual(['MID VALLEY', 'THE COMMUNE KULAI']);
    expect(month.map((o) => o.venue)).toEqual([
      'SUNWAY PYRAMID CONVENTION CENTRE',
      'MVEC SOUTHKEY',
    ]);
  });

  it('shows dates ONLY on rows that would otherwise read identically', () => {
    /* MVEC SOUTHKEY / REX, August 2026: 8-10 and 14-16. Four such pairs exist in
       seven months; they are the entire reason the date is ever rendered. */
    const rows = [
      fair({ projectId: 152, venue: 'MVEC SOUTHKEY', startDate: '2026-08-08', endDate: '2026-08-10' }),
      fair({ projectId: 468, venue: 'MVEC SOUTHKEY', startDate: '2026-08-14', endDate: '2026-08-16' }),
      fair({ projectId: 150, venue: 'PAVILION BUKIT JALIL', organizer: 'MEGAHOME', startDate: '2026-08-07', endDate: '2026-08-09' }),
    ];
    const { month } = buildFairOptions(rows, '2026-08-20');
    const mvec = month.filter((o) => o.venue === 'MVEC SOUTHKEY');
    expect(mvec).toHaveLength(2);
    expect(mvec.every((o) => o.showDates)).toBe(true);
    expect(fairOptionLabel(mvec[0])).toBe('MVEC SOUTHKEY — REX (2026-08-08 ~ 2026-08-10)');
    const pavilion = month.find((o) => o.venue === 'PAVILION BUKIT JALIL');
    expect(pavilion?.showDates).toBe(false);
    expect(fairOptionLabel(pavilion!)).toBe('PAVILION BUKIT JALIL — MEGAHOME');
  });

  it('reads a SOLO roadshow as SOLO and leaves an exhibition its organizer (owner 2026-09-18)', () => {
    /* Production 2026-09: IOI MALL PUTRAJAYA / MALL MGT and SUNWAY CARNIVAL /
       MALL MGMT are event type "solo"; SETIA SPICE / HOMELOVE is an exhibition. */
    const rows = [
      fair({ projectId: 1, venue: 'IOI MALL PUTRAJAYA', organizer: 'MALL MGT', eventType: 'solo' }),
      fair({ projectId: 2, venue: 'SETIA SPICE CONVENTION CENTRE', organizer: 'HOMELOVE', eventType: 'exhibition' }),
      fair({ projectId: 3, venue: 'PAVILION BUKIT JALIL', organizer: 'MEGAHOME' }),
    ];
    const { running } = buildFairOptions(rows, '2026-09-12');
    expect(running.map(fairOptionLabel)).toEqual([
      'IOI MALL PUTRAJAYA — SOLO',
      'PAVILION BUKIT JALIL — MEGAHOME',
      'SETIA SPICE CONVENTION CENTRE — HOMELOVE',
    ]);
    /* The label changed, the identity did not: the save path still resolves the
       project from the real organizer. */
    expect(running[0].organizer).toBe('MALL MGT');
    expect(running[0].key).toContain('mall mgt');
  });

  it('dates two SOLO roadshows at one venue that would both read SOLO', () => {
    const rows = [
      fair({ projectId: 1, venue: 'SUNWAY CARNIVAL', organizer: 'MALL MGMT', eventType: 'solo', startDate: '2026-09-04', endDate: '2026-09-06' }),
      fair({ projectId: 2, venue: 'SUNWAY CARNIVAL', organizer: 'VINCENT (VTEAM EVENT)', eventType: 'solo', startDate: '2026-09-18', endDate: '2026-09-20' }),
    ];
    const { month } = buildFairOptions(rows, '2026-09-12');
    expect(month.map(fairOptionLabel)).toEqual([
      'SUNWAY CARNIVAL — SOLO (2026-09-04 ~ 2026-09-06)',
      'SUNWAY CARNIVAL — SOLO (2026-09-18 ~ 2026-09-20)',
    ]);
  });

  it('keeps a fair that straddles the month end while the order is inside it', () => {
    const rows = [fair({ projectId: 159, startDate: '2026-08-28', endDate: '2026-09-02' })];
    const { running } = buildFairOptions(rows, '2026-09-01');
    expect(running).toHaveLength(1);
    expect(running[0].projectIds).toEqual([159]);
  });

  it('drops cancelled fairs, and fairs missing a place or an organizer', () => {
    const rows = [
      fair({ projectId: 209, status: 'cancelled' }),
      fair({ projectId: 900, organizer: '  ' }),
      fair({ projectId: 901, venue: null }),
      fair({ projectId: 902, startDate: null }),
    ];
    const { running, month } = buildFairOptions(rows, '2026-09-13');
    expect(running).toHaveLength(0);
    expect(month).toHaveLength(0);
  });

  it('returns nothing for a malformed order date rather than inventing a month', () => {
    expect(buildFairOptions(MID_VALLEY_REX, '')).toEqual({ running: [], month: [] });
    expect(buildFairOptions(MID_VALLEY_REX, '13/09/2026')).toEqual({ running: [], month: [] });
  });
});

describe('periodContains / isPickableFair', () => {
  it('treats end_date as INCLUSIVE — the last day of a fair is a trading day', () => {
    expect(periodContains({ startDate: '2026-09-11', endDate: '2026-09-13' }, '2026-09-13')).toBe(true);
    expect(periodContains({ startDate: '2026-09-11', endDate: '2026-09-13' }, '2026-09-14')).toBe(false);
  });

  it('treats a NULL end as still running, and a NULL start as containing nothing', () => {
    expect(periodContains({ startDate: '2026-09-11', endDate: null }, '2027-01-01')).toBe(true);
    expect(periodContains({ startDate: null, endDate: '2026-09-13' }, '2026-09-12')).toBe(false);
  });

  it('accepts a live fair', () => {
    expect(isPickableFair(fair({ projectId: 340 }))).toBe(true);
  });
});

describe('resolveFair — the brand decides which booth, and it is never guessed', () => {
  it('picks the booth whose brand matches the order', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: 'ZANOTTI', organizer: 'REX',
    });
    expect(r).toEqual({ projectId: 341, match: 'PICKED', candidateIds: [340, 341, 342, 2250] });
  });

  it('takes the lowest id when two records describe the SAME booth', () => {
    /* 342 and 2250 are the same ERGOTEX booth entered twice. A documented,
       stable arbiter beats a coin flip and beats refusing a real answer. */
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: 'ERGOTEX', organizer: 'REX',
    });
    expect(r.projectId).toBe(342);
    expect(r.match).toBe('PICKED');
  });

  it('is case- and space-insensitive on brand and organizer', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: ' zanotti ', organizer: 'rex',
    });
    expect(r.projectId).toBe(341);
  });

  it('says PENDING when no fair is running there yet — the venue still stands', () => {
    /* 23% of fairs reach the system within a week of opening; 13 of 114 arrived
       after they had already started. The order must not be blocked or guessed. */
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-20', brand: 'AKEMI', organizer: 'REX',
    });
    expect(r).toEqual({ projectId: null, match: 'PENDING', candidateIds: [] });
  });

  it('says UNMATCHED when the order sells a brand that has no booth there', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: 'DUNLOPILLO', organizer: 'REX',
    });
    expect(r.projectId).toBeNull();
    expect(r.match).toBe('UNMATCHED');
    expect(r.candidateIds).toEqual([340, 341, 342, 2250]);
  });

  it('says AMBIGUOUS when the catalogue has no brand and several booths fit', () => {
    /* 104 of Houzs Century's main products carried no brand on 2026-09-13, so a
       null brand is normal — and it means "cannot narrow", never "no match". */
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: null, organizer: 'REX',
    });
    expect(r.projectId).toBeNull();
    expect(r.match).toBe('AMBIGUOUS');
  });

  it('still resolves a brandless order when the event has exactly one booth', () => {
    const r = resolveFair({
      candidates: [fair({ projectId: 2258, venue: 'THE COMMUNE KULAI', organizer: 'INHOME' })],
      soDate: '2026-09-13', brand: null, organizer: 'INHOME',
    });
    expect(r).toEqual({ projectId: 2258, match: 'PICKED', candidateIds: [2258] });
  });

  it('separates two organizers at one venue on one day', () => {
    /* MID VALLEY, 20 Mar 2026: MLE and REX at the same place on the same day.
       Three such days in all of 2026 — rare, but the organizer on the row is
       what keeps them apart. */
    const candidates = [
      fair({ projectId: 2031, organizer: 'REX', startDate: '2026-03-20', endDate: '2026-03-20' }),
      fair({ projectId: 2032, organizer: 'MLE', startDate: '2026-03-20', endDate: '2026-03-20' }),
    ];
    expect(resolveFair({ candidates, soDate: '2026-03-20', brand: 'AKEMI', organizer: 'MLE' }).projectId).toBe(2032);
    expect(resolveFair({ candidates, soDate: '2026-03-20', brand: 'AKEMI', organizer: 'REX' }).projectId).toBe(2031);
  });

  it('resolves the "Others" path — a place was picked and no organizer', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, soDate: '2026-09-13', brand: 'AKEMI', organizer: null,
    });
    expect(r.projectId).toBe(340);
    expect(r.match).toBe('PICKED');
  });

  it('goes AMBIGUOUS on the "Others" path when two organizers share the day', () => {
    const candidates = [
      fair({ projectId: 2031, organizer: 'REX', brand: 'AKEMI', startDate: '2026-03-20', endDate: '2026-03-20' }),
      fair({ projectId: 2032, organizer: 'MLE', brand: 'AKEMI', startDate: '2026-03-20', endDate: '2026-03-20' }),
    ];
    const r = resolveFair({ candidates, soDate: '2026-03-20', brand: 'AKEMI', organizer: null });
    /* Same brand, two DIFFERENT organizers — two separate fairs with separate
       P&L. Two records of one booth collapse to the lowest id; two organizers
       must not, or the lowest id becomes a guess wearing a rule's clothes. */
    expect(r).toEqual({ projectId: null, match: 'AMBIGUOUS', candidateIds: [2031, 2032] });
  });

  it('never reads a cancelled fair as a match', () => {
    const r = resolveFair({
      candidates: [fair({ projectId: 209, status: 'cancelled' })],
      soDate: '2026-09-13', brand: 'AKEMI', organizer: 'REX',
    });
    expect(r.match).toBe('PENDING');
  });
});
