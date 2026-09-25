import { describe, it, expect } from 'vitest';
import {
  buildFairOptions,
  resolveFair,
  fairOptionLabel,
  isPickableFair,
  periodContains,
  lookbackWindow,
  fairPickedPeriod,
  editFairPick,
  fairDayOnSave,
  fairDayMissing,
  linkedFairOf,
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
 * MVEC SOUTHKEY / REX pair is the August double-booking that shows why a row
 * has to name its occurrence and not just its venue and organizer.
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

  it('labels EVERY row with its dates (owner 2026-09-19, reversing 2026-09-13)', () => {
    /* The list is now four weeks of mostly-CLOSED fairs, so picking a row means
       saying WHICH occurrence — the label has to show it or the operator is
       guessing. The old `showDates` exception is gone, not widened. */
    const { running } = buildFairOptions(MID_VALLEY_REX, '2026-09-13');
    expect(fairOptionLabel(running[0])).toBe('MID VALLEY — REX (09/11 - 09/13)');
  });

  it('renders a one-day fair as a single date, not a range', () => {
    const rows = [fair({ projectId: 1, startDate: '2026-09-13', endDate: '2026-09-13' })];
    const { running } = buildFairOptions(rows, '2026-09-13');
    expect(fairOptionLabel(running[0])).toBe('MID VALLEY — REX (09/13)');
  });

  it('splits running-today from the fairs that have already closed', () => {
    const rows = [
      ...MID_VALLEY_REX,
      fair({ projectId: 2258, venue: 'THE COMMUNE KULAI', organizer: 'INHOME' }),
      fair({ projectId: 346, venue: 'MVEC SOUTHKEY', organizer: 'MLE', startDate: '2026-09-18', endDate: '2026-09-20' }),
      fair({ projectId: 361, venue: 'SUNWAY PYRAMID CONVENTION CENTRE', organizer: 'BIGHOME', startDate: '2026-09-04', endDate: '2026-09-06' }),
    ];
    const { running, earlier } = buildFairOptions(rows, '2026-09-13');
    expect(running.map((o) => o.venue)).toEqual(['MID VALLEY', 'THE COMMUNE KULAI']);
    /* MVEC SOUTHKEY opens on the 18th. It used to be offered on the 13th as part
       of "this month"; it is not offered at all now, because nobody writes an
       order for a fair that has not happened yet. */
    expect(earlier.map((o) => o.venue)).toEqual(['SUNWAY PYRAMID CONVENTION CENTRE']);
  });

  it('NEVER offers a fair that has not started yet', () => {
    const rows = [
      fair({ projectId: 1, venue: 'FUTURE HALL', startDate: '2026-09-20', endDate: '2026-09-22' }),
      fair({ projectId: 2, venue: 'TOMORROW HALL', startDate: '2026-09-14', endDate: '2026-09-14' }),
    ];
    const { running, earlier } = buildFairOptions(rows, '2026-09-13');
    expect(running).toHaveLength(0);
    expect(earlier).toHaveLength(0);
  });

  it('reaches back FOUR WEEKS, across the month boundary, and stops there', () => {
    /* The order the owner described: keyed on 2 Oct, written up for a fair that
       ran 18-20 Sep. Under the old calendar-month window that fair appeared in
       neither group, so the sale could not be attributed at all. */
    const rows = [
      fair({ projectId: 1, venue: 'SEPTEMBER HALL', startDate: '2026-09-18', endDate: '2026-09-20' }),
      fair({ projectId: 2, venue: 'EDGE OF WINDOW', startDate: '2026-09-04', endDate: '2026-09-04' }),
      fair({ projectId: 3, venue: 'TOO OLD', startDate: '2026-09-02', endDate: '2026-09-03' }),
    ];
    const { running, earlier } = buildFairOptions(rows, '2026-10-02');
    expect(running).toHaveLength(0);
    /* Newest first: the fair that just closed is overwhelmingly the one being
       written up. 2 Oct minus 28 days is 4 Sep, so EDGE OF WINDOW is the last
       row that qualifies and TOO OLD misses by a day. */
    expect(earlier.map((o) => o.venue)).toEqual(['SEPTEMBER HALL', 'EDGE OF WINDOW']);
  });

  it('keeps two occurrences of ONE venue+organizer apart by their dates', () => {
    /* MVEC SOUTHKEY / REX, August 2026: 8-10 and 14-16. Both sit inside the
       window on the 20th, and with only venue+organizer on screen they would be
       the same row twice — which is the whole reason a pick has to name a
       period rather than just a place and a name. */
    const rows = [
      fair({ projectId: 152, venue: 'MVEC SOUTHKEY', startDate: '2026-08-08', endDate: '2026-08-10' }),
      fair({ projectId: 468, venue: 'MVEC SOUTHKEY', startDate: '2026-08-14', endDate: '2026-08-16' }),
    ];
    const { earlier } = buildFairOptions(rows, '2026-08-20');
    expect(earlier.map(fairOptionLabel)).toEqual([
      'MVEC SOUTHKEY — REX (08/14 - 08/16)',
      'MVEC SOUTHKEY — REX (08/08 - 08/10)',
    ]);
    expect(new Set(earlier.map((o) => o.key)).size).toBe(2);
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
      'IOI MALL PUTRAJAYA — SOLO (09/11 - 09/13)',
      'PAVILION BUKIT JALIL — MEGAHOME (09/11 - 09/13)',
      'SETIA SPICE CONVENTION CENTRE — HOMELOVE (09/11 - 09/13)',
    ]);
    /* The label changed, the identity did not: the save path still resolves the
       project from the real organizer. */
    expect(running[0].organizer).toBe('MALL MGT');
    expect(running[0].key).toContain('mall mgt');
  });

  it('tells two SOLO roadshows at one venue apart, since both read SOLO', () => {
    const rows = [
      fair({ projectId: 1, venue: 'SUNWAY CARNIVAL', organizer: 'MALL MGMT', eventType: 'solo', startDate: '2026-09-04', endDate: '2026-09-06' }),
      fair({ projectId: 2, venue: 'SUNWAY CARNIVAL', organizer: 'VINCENT (VTEAM EVENT)', eventType: 'solo', startDate: '2026-09-09', endDate: '2026-09-10' }),
    ];
    const { earlier } = buildFairOptions(rows, '2026-09-12');
    expect(earlier.map(fairOptionLabel)).toEqual([
      'SUNWAY CARNIVAL — SOLO (09/09 - 09/10)',
      'SUNWAY CARNIVAL — SOLO (09/04 - 09/06)',
    ]);
  });

  it('keeps a fair that straddles the month end while the order is inside it', () => {
    const rows = [fair({ projectId: 159, startDate: '2026-08-28', endDate: '2026-09-02' })];
    const { running, earlier } = buildFairOptions(rows, '2026-09-01');
    expect(running).toHaveLength(1);
    expect(earlier).toHaveLength(0);
    expect(running[0].projectIds).toEqual([159]);
  });

  it('drops cancelled fairs, and fairs missing a place or an organizer', () => {
    const rows = [
      fair({ projectId: 209, status: 'cancelled' }),
      fair({ projectId: 900, organizer: '  ' }),
      fair({ projectId: 901, venue: null }),
      fair({ projectId: 902, startDate: null }),
    ];
    const { running, earlier } = buildFairOptions(rows, '2026-09-13');
    expect(running).toHaveLength(0);
    expect(earlier).toHaveLength(0);
  });

  it('returns nothing for a malformed order date rather than inventing a window', () => {
    expect(buildFairOptions(MID_VALLEY_REX, '')).toEqual({ running: [], earlier: [] });
    expect(buildFairOptions(MID_VALLEY_REX, '13/09/2026')).toEqual({ running: [], earlier: [] });
  });
});

describe('periodContains / isPickableFair', () => {
  it('treats end_date as INCLUSIVE — the last day of a fair is a trading day', () => {
    expect(periodContains({ startDate: '2026-09-11', endDate: '2026-09-13' }, '2026-09-13')).toBe(true);
    expect(periodContains({ startDate: '2026-09-11', endDate: '2026-09-13' }, '2026-09-14')).toBe(false);
  });

  it('treats a NULL end as ONE DAY, and a NULL start as containing nothing', () => {
    /* Changed 2026-09-19. A blank end used to mean open-ended, so a fair that
       started in March and never declared an end stayed under "Running now" in
       September — while the Projects calendar read the same blank as
       `COALESCE(end_date, start_date)` and drew a one-day bar back in March.
       Two screens, one column, opposite answers. This side was the wrong one:
       a fair the calendar says is over must not be offered as running. */
    expect(periodContains({ startDate: '2026-09-11', endDate: null }, '2026-09-11')).toBe(true);
    expect(periodContains({ startDate: '2026-09-11', endDate: null }, '2026-09-12')).toBe(false);
    expect(periodContains({ startDate: '2026-09-11', endDate: null }, '2027-01-01')).toBe(false);
    expect(periodContains({ startDate: null, endDate: '2026-09-13' }, '2026-09-12')).toBe(false);
  });

  it('lookbackWindow is 28 days back from the order date, inclusive, never forward', () => {
    expect(lookbackWindow('2026-09-10')).toEqual({ start: '2026-08-13', end: '2026-09-10' });
    /* Crosses a month end and a year end without special-casing either. */
    expect(lookbackWindow('2026-01-05')).toEqual({ start: '2025-12-08', end: '2026-01-05' });
  });

  it('fairPickedPeriod takes a valid start, tolerates a missing end, refuses junk', () => {
    expect(fairPickedPeriod({ fairStart: '2026-09-11', fairEnd: '2026-09-13' }))
      .toEqual({ startDate: '2026-09-11', endDate: '2026-09-13' });
    /* A one-day fair legitimately has no end. */
    expect(fairPickedPeriod({ fairStart: '2026-09-11' }))
      .toEqual({ startDate: '2026-09-11', endDate: null });
    /* No start means no event was picked — fall back to the venue window rather
       than run a lookup that matches nothing and blames the data. */
    expect(fairPickedPeriod({})).toBeNull();
    expect(fairPickedPeriod({ fairStart: '11/09/2026' })).toBeNull();
    expect(fairPickedPeriod({ fairStart: 20260911 })).toBeNull();
  });

  it('accepts a live fair', () => {
    expect(isPickableFair(fair({ projectId: 340 }))).toBe(true);
  });
});

describe('resolveFair — the brand decides which booth, and it is never guessed', () => {
  it('picks the booth whose brand matches the order', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: 'ZANOTTI', organizer: 'REX',
    });
    expect(r).toEqual({ projectId: 341, match: 'PICKED', candidateIds: [340, 341, 342, 2250] });
  });

  it('takes the lowest id when two records describe the SAME booth', () => {
    /* 342 and 2250 are the same ERGOTEX booth entered twice. A documented,
       stable arbiter beats a coin flip and beats refusing a real answer. */
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: 'ERGOTEX', organizer: 'REX',
    });
    expect(r.projectId).toBe(342);
    expect(r.match).toBe('PICKED');
  });

  it('is case- and space-insensitive on brand and organizer', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: ' zanotti ', organizer: 'rex',
    });
    expect(r.projectId).toBe(341);
  });

  it('says PENDING when the lookup found no fair at all — the venue still stands', () => {
    /* 23% of fairs reach the system within a week of opening; 13 of 114 arrived
       after they had already started. The order must not be blocked or guessed. */
    const r = resolveFair({ candidates: [], brand: 'AKEMI', organizer: 'REX' });
    expect(r).toEqual({ projectId: null, match: 'PENDING', candidateIds: [] });
  });

  it('DOES NOT re-check the order date against the period (owner 2026-09-19)', () => {
    /* The order was keyed on 20 Sep for a fair that closed on the 13th — the
       owner's own case, *"下个星期才开给上个星期 event 的 sales order"*. This used
       to answer PENDING from a date filter right here, and because the nightly
       reconcile and the settle-by-hand screen ran the same line, the order could
       never be attributed by ANY path. The caller has already narrowed to the
       event the operator picked; second-guessing it with a keying date is what
       broke. */
    const r = resolveFair({ candidates: MID_VALLEY_REX, brand: 'AKEMI', organizer: 'REX' });
    expect(r).toEqual({ projectId: 340, match: 'PICKED', candidateIds: [340, 341, 342, 2250] });
  });

  it('will NOT collapse two occurrences of one booth into the lower id', () => {
    /* REX / AKEMI at MID VALLEY twice inside the four-week window. Before the
       period joined the booth key these read as one booth and the second fair's
       sales posted to the first fair's P&L. Two rows differing only by period
       are DIFFERENT FAIRS; a person decides. */
    const candidates = [
      fair({ projectId: 401, startDate: '2026-09-04', endDate: '2026-09-06' }),
      fair({ projectId: 402, startDate: '2026-09-11', endDate: '2026-09-13' }),
    ];
    const r = resolveFair({ candidates, brand: 'AKEMI', organizer: 'REX' });
    expect(r).toEqual({ projectId: null, match: 'AMBIGUOUS', candidateIds: [401, 402] });
  });

  it('says UNMATCHED when the order sells a brand that has no booth there', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: 'DUNLOPILLO', organizer: 'REX',
    });
    expect(r.projectId).toBeNull();
    expect(r.match).toBe('UNMATCHED');
    expect(r.candidateIds).toEqual([340, 341, 342, 2250]);
  });

  it('says AMBIGUOUS when the catalogue has no brand and several booths fit', () => {
    /* 104 of Houzs Century's main products carried no brand on 2026-09-13, so a
       null brand is normal — and it means "cannot narrow", never "no match". */
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: null, organizer: 'REX',
    });
    expect(r.projectId).toBeNull();
    expect(r.match).toBe('AMBIGUOUS');
  });

  it('still resolves a brandless order when the event has exactly one booth', () => {
    const r = resolveFair({
      candidates: [fair({ projectId: 2258, venue: 'THE COMMUNE KULAI', organizer: 'INHOME' })],
      brand: null, organizer: 'INHOME',
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
    expect(resolveFair({ candidates, brand: 'AKEMI', organizer: 'MLE' }).projectId).toBe(2032);
    expect(resolveFair({ candidates, brand: 'AKEMI', organizer: 'REX' }).projectId).toBe(2031);
  });

  it('resolves the "Others" path — a place was picked and no organizer', () => {
    const r = resolveFair({
      candidates: MID_VALLEY_REX, brand: 'AKEMI', organizer: null,
    });
    expect(r.projectId).toBe(340);
    expect(r.match).toBe('PICKED');
  });

  it('goes AMBIGUOUS on the "Others" path when two organizers share the day', () => {
    const candidates = [
      fair({ projectId: 2031, organizer: 'REX', brand: 'AKEMI', startDate: '2026-03-20', endDate: '2026-03-20' }),
      fair({ projectId: 2032, organizer: 'MLE', brand: 'AKEMI', startDate: '2026-03-20', endDate: '2026-03-20' }),
    ];
    const r = resolveFair({ candidates, brand: 'AKEMI', organizer: null });
    /* Same brand, two DIFFERENT organizers — two separate fairs with separate
       P&L. Two records of one booth collapse to the lowest id; two organizers
       must not, or the lowest id becomes a guess wearing a rule's clothes. */
    expect(r).toEqual({ projectId: null, match: 'AMBIGUOUS', candidateIds: [2031, 2032] });
  });

  it('never reads a cancelled fair as a match', () => {
    const r = resolveFair({
      candidates: [fair({ projectId: 209, status: 'cancelled' })],
      brand: 'AKEMI', organizer: 'REX',
    });
    expect(r.match).toBe('PENDING');
  });
});

/* Owner 2026-09-24, backfilling an old order: 「我选了那个场（Mid Valley，MLE，8 号到
   9 号），选了过后，它就自动记下是那个场地的…包括 venue, organiser 和那个日期」. */
describe('editFairPick — what an edit save picked', () => {
  it('an event: the picked row\'s venue, organizer and period', () => {
    expect(editFairPick({
      fairVenue: 'MID VALLEY', venue: 'Mid Valley Exhibition Centre',
      fairOrganizer: ' MLE ', fairStart: '2026-08-08', fairEnd: '2026-08-09',
    }, 'MID VALLEY')).toEqual({ venue: 'MID VALLEY', organizer: 'MLE', picked: { startDate: '2026-08-08', endDate: '2026-08-09' } });
  });

  it('without the row venue, the sent venue and then the stored one name the place', () => {
    const event = { fairOrganizer: 'MLE', fairStart: '2026-08-08', fairEnd: null };
    expect(editFairPick({ ...event, venue: 'IOI CITY MALL' }, 'MID VALLEY')?.venue).toBe('IOI CITY MALL');
    expect(editFairPick(event, 'MID VALLEY')?.venue).toBe('MID VALLEY');
    expect(editFairPick(event, 'MID VALLEY')?.picked).toEqual({ startDate: '2026-08-08', endDate: null });
  });

  it('a place alone, a clear, or an incomplete event picks nothing', () => {
    expect(editFairPick({ venue: 'MID VALLEY' }, 'MID VALLEY')).toBeNull();
    expect(editFairPick({ fairVenue: null, fairOrganizer: null, fairStart: null, fairEnd: null }, 'MID VALLEY')).toBeNull();
    expect(editFairPick({ fairOrganizer: 'MLE', fairStart: '08/08/2026' }, 'MID VALLEY')).toBeNull();
    expect(editFairPick({ fairOrganizer: '  ', fairStart: '2026-08-08' }, 'MID VALLEY')).toBeNull();
    expect(editFairPick({ fairOrganizer: 'MLE', fairStart: '2026-08-08' }, null)).toBeNull();
  });
});

/* Owner 2026-09-24: the event runs 7-9, 「他一选完那个 event，这边下拉菜单就要拉出来 7、8、9
   三天给他选。这样我就可以确切知道他这张单是在哪一天开的」. */
describe('fairDayOnSave — the day kept is a day of the picked event', () => {
  const EVENT = { fairOrganizer: 'MLE', fairStart: '2026-09-07', fairEnd: '2026-09-09' };

  it('keeps any day of the event, first and last included', () => {
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-07' }, '2026-09-20')).toBe('2026-09-07');
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-08' }, '2026-09-20')).toBe('2026-09-08');
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-09' }, '2026-09-20')).toBe('2026-09-09');
  });

  it('drops a day outside the event, or after the order date', () => {
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-06' }, '2026-09-20')).toBeNull();
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-10' }, '2026-09-20')).toBeNull();
    /* Keyed on the 8th: the 9th had not happened yet. */
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-09' }, '2026-09-08')).toBeNull();
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-08' }, '2026-09-08')).toBe('2026-09-08');
  });

  it('a one-day fair (no end) has exactly one day', () => {
    const oneDay = { fairOrganizer: 'MLE', fairStart: '2026-09-07', fairEnd: null };
    expect(fairDayOnSave({ ...oneDay, fairDate: '2026-09-07' }, '2026-09-20')).toBe('2026-09-07');
    expect(fairDayOnSave({ ...oneDay, fairDate: '2026-09-08' }, '2026-09-20')).toBeNull();
  });

  it('keeps no day without an event beside it, and none that is not a date', () => {
    expect(fairDayOnSave({ fairDate: '2026-09-08' }, '2026-09-20')).toBeNull();
    expect(fairDayOnSave({ fairStart: '2026-09-07', fairEnd: '2026-09-09', fairDate: '2026-09-08' }, '2026-09-20')).toBeNull();
    expect(fairDayOnSave({ ...EVENT, fairDate: '08/09/2026' }, '2026-09-20')).toBeNull();
    expect(fairDayOnSave({ ...EVENT, fairDate: null }, '2026-09-20')).toBeNull();
    expect(fairDayOnSave({ ...EVENT }, '2026-09-20')).toBeNull();
  });

  it('with no order date to cap by, the event alone bounds the day', () => {
    expect(fairDayOnSave({ ...EVENT, fairDate: '2026-09-09' }, null)).toBe('2026-09-09');
  });
});

describe('fairDayMissing — an event picked without a day of it', () => {
  const EVENT = { fairOrganizer: 'MLE', fairStart: '2026-09-07', fairEnd: '2026-09-09' };

  it('asks for the day when an event is picked without one, or with a stray one', () => {
    expect(fairDayMissing({ ...EVENT }, '2026-09-20')).toBe(true);
    expect(fairDayMissing({ ...EVENT, fairDate: null }, '2026-09-20')).toBe(true);
    expect(fairDayMissing({ ...EVENT, fairDate: '2026-09-12' }, '2026-09-20')).toBe(true);
    expect(fairDayMissing({ ...EVENT, fairDate: '2026-09-08' }, '2026-09-20')).toBe(false);
  });

  it('a place alone, or no pick at all, needs no day', () => {
    expect(fairDayMissing({}, '2026-09-20')).toBe(false);
    expect(fairDayMissing({ fairOrganizer: null, fairStart: null, fairEnd: null, fairDate: null }, '2026-09-20')).toBe(false);
    expect(fairDayMissing({ fairOrganizer: 'MLE' }, '2026-09-20')).toBe(false);
  });
});

describe('linkedFairOf — a recorded pick reads back as the row that was picked', () => {
  it('carries the venue, organizer, SOLO flag and period', () => {
    expect(linkedFairOf(fair({ projectId: 500, organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09' })))
      .toEqual({ venue: 'MID VALLEY', organizer: 'MLE', solo: false, startDate: '2026-08-08', endDate: '2026-08-09' });
    expect(linkedFairOf(fair({ projectId: 501, organizer: 'MALL MGT', eventType: 'solo', endDate: null })))
      .toEqual({ venue: 'MID VALLEY', organizer: 'MALL MGT', solo: true, startDate: '2026-09-11', endDate: null });
  });

  it('a project that could never have been a row reads back as nothing', () => {
    expect(linkedFairOf(fair({ projectId: 502, venue: null }))).toBeNull();
    expect(linkedFairOf(fair({ projectId: 503, organizer: '' }))).toBeNull();
    expect(linkedFairOf(fair({ projectId: 504, startDate: null }))).toBeNull();
  });

  it('a fair cancelled after the link still reads back — it is what the order is attributed to', () => {
    expect(linkedFairOf(fair({ projectId: 505, status: 'cancelled' }))?.organizer).toBe('REX');
  });
});
