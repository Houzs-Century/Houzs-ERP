/* What a Fair pick means on an EDIT save (owner 2026-09-24): 「我选了那个场（Mid Valley，
 * MLE，8 号到 9 号），选了过后，它就自动记下是那个场地的，包括 venue, organiser 和那个
 * 日期」. The desktop SO page and the phone editor both diff a SEEDED header payload
 * against the current one (so-header-diff.ts), so the property that matters is
 * what that diff sends: nothing when the picker is untouched, the fair keys when
 * another event (or another day of it) is picked, nulls when the operator falls
 * back to Others.
 */
import { describe, expect, it } from 'vitest';
import { diffHeaderPayload } from '../vendor/scm/lib/so-header-diff';
import {
  fairDayCheck, fairDaysOf, fairEditPatch, fairEventOf, fairPickValue, linkedEvent, soleFairDay, type LinkedFair,
} from './fairPick';

const MLE: LinkedFair = { venue: 'MID VALLEY', organizer: 'MLE', solo: false, startDate: '2026-08-08', endDate: '2026-08-09' };

/* One edit session, both surfaces' shape: the baseline is built from the loaded
   order, the outgoing payload from whatever the picker now holds. */
const session = (orderVenue: string | null, linked: LinkedFair | null, day: string | null = null) => {
  const seeded = fairPickValue(orderVenue, linkedEvent(orderVenue, linked, day));
  const baseline = fairEditPatch(linkedEvent(orderVenue, linked, day));
  return { seeded, sent: (picker: typeof seeded) => diffHeaderPayload(baseline, fairEditPatch(fairEventOf(picker))) };
};

describe('an edit save and the Fair picker', () => {
  it('an untouched picker sends nothing — linked or not, with a day or without', () => {
    const linked = session('MID VALLEY', MLE);
    expect(linked.sent(linked.seeded)).toEqual({});
    const withDay = session('MID VALLEY', MLE, '2026-08-09');
    expect(withDay.sent(withDay.seeded)).toEqual({});
    const unlinked = session('SPICE ARENA', null);
    expect(unlinked.sent(unlinked.seeded)).toEqual({});
  });

  it('a recorded pick reads back as its event: venue, organizer, dates and the day', () => {
    expect(session('MID VALLEY', MLE, '2026-08-09').seeded)
      .toEqual({ venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09', day: '2026-08-09' });
  });

  it('picking another event sends that event whole', () => {
    const s = session('MID VALLEY', MLE);
    const bighome = { venue: 'MID VALLEY', organizer: 'BIGHOME', startDate: '2026-08-15', endDate: '2026-08-17', day: '2026-08-16' };
    expect(s.sent(bighome))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'BIGHOME', fairStart: '2026-08-15', fairEnd: '2026-08-17', fairDate: '2026-08-16' });
  });

  it('the unchanged parts of the new event travel too — never half an event', () => {
    /* Same venue and end date as the linked MLE fair, another organizer and
       start. Sent by halves, the server would read the missing end as a
       one-day fair and match nothing. */
    const s = session('MID VALLEY', MLE);
    expect(s.sent({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-08-07', endDate: '2026-08-09', day: null }))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'REX', fairStart: '2026-08-07', fairEnd: '2026-08-09', fairDate: null });
  });

  it('another day of the same event sends the event with it — the server checks a day against its event', () => {
    const s = session('MID VALLEY', MLE, '2026-08-08');
    expect(s.sent({ ...s.seeded, day: '2026-08-09' }))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'MLE', fairStart: '2026-08-08', fairEnd: '2026-08-09', fairDate: '2026-08-09' });
  });

  it('backfilling an order that had no event sends the picked one', () => {
    const s = session(null, null);
    expect(s.sent({ venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09', day: '2026-08-08' }))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'MLE', fairStart: '2026-08-08', fairEnd: '2026-08-09', fairDate: '2026-08-08' });
  });

  it('falling back to Others (a place alone) sends the event and its day as cleared', () => {
    const s = session('MID VALLEY', MLE, '2026-08-08');
    expect(s.sent({ venue: 'IOI CITY MALL', organizer: null, startDate: null, endDate: null, day: null }))
      .toEqual({ fairVenue: null, fairOrganizer: null, fairStart: null, fairEnd: null, fairDate: null });
  });
});

describe('linkedEvent — the link is shown only under its own venue', () => {
  it('matches the order venue case- and space-insensitively, spelled as the ORDER spells it', () => {
    expect(linkedEvent('Mid  Valley ', MLE, '2026-08-09'))
      .toEqual({ venue: 'Mid  Valley ', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09', day: '2026-08-09' });
  });

  it('a link to a fair at ANOTHER venue is not shown as this order\'s event', () => {
    /* HC-SO-2609-081 on 2026-09-24: venue KUALA LUMPUR CONVENTION CENTRE, linked to
       a fair at IOI MALL PUTRAJAYA. Showing that event under the order's venue
       would present a contradiction as one answer. */
    expect(linkedEvent('KUALA LUMPUR CONVENTION CENTRE', { ...MLE, venue: 'IOI MALL PUTRAJAYA' }, null)).toBeNull();
  });

  it('no link, or no venue on the order, is no event', () => {
    expect(linkedEvent('MID VALLEY', null, null)).toBeNull();
    expect(linkedEvent('MID VALLEY', undefined, null)).toBeNull();
    expect(linkedEvent(null, MLE, null)).toBeNull();
  });
});

describe('fairEventOf', () => {
  it('a place alone is not an event', () => {
    expect(fairEventOf({ venue: 'MID VALLEY', organizer: null, startDate: null, endDate: null, day: null })).toBeNull();
    expect(fairEventOf({ venue: null, organizer: null, startDate: null, endDate: null, day: null })).toBeNull();
  });
});

/* Owner 2026-09-24: the event runs 7-9, 「他一选完那个 event，这边下拉菜单就要拉出来 7、8、9
   三天给他选」. */
describe('fairDaysOf — the days the Fair Day column offers', () => {
  const SEVEN_TO_NINE = { startDate: '2026-09-07', endDate: '2026-09-09' };

  it('every day of the event, first to last', () => {
    expect(fairDaysOf(SEVEN_TO_NINE, '2026-09-24')).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
  });

  it('never a day after the order date — keyed on the 8th, the 9th has not happened', () => {
    expect(fairDaysOf(SEVEN_TO_NINE, '2026-09-08')).toEqual(['2026-09-07', '2026-09-08']);
    expect(fairDaysOf(SEVEN_TO_NINE, '2026-09-06')).toEqual([]);
  });

  it('with no order date yet, the event alone decides', () => {
    expect(fairDaysOf(SEVEN_TO_NINE, null)).toEqual(['2026-09-07', '2026-09-08', '2026-09-09']);
  });

  it('a missing end is one day; a period across a month end needs no special case', () => {
    expect(fairDaysOf({ startDate: '2026-09-07', endDate: null }, null)).toEqual(['2026-09-07']);
    expect(fairDaysOf({ startDate: '2026-08-30', endDate: '2026-09-01' }, null)).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
  });

  it('no event, no days', () => {
    expect(fairDaysOf({ startDate: null, endDate: null }, '2026-09-24')).toEqual([]);
  });
});

describe('soleFairDay — filled in only when there is nothing to choose', () => {
  it('a one-day fair, or the first day of a fair still running, is the answer', () => {
    expect(soleFairDay({ startDate: '2026-09-07', endDate: null }, '2026-09-24')).toBe('2026-09-07');
    expect(soleFairDay({ startDate: '2026-09-07', endDate: '2026-09-09' }, '2026-09-07')).toBe('2026-09-07');
  });

  it('several days are the operator\'s to pick — never a guess from today', () => {
    expect(soleFairDay({ startDate: '2026-09-07', endDate: '2026-09-09' }, '2026-09-24')).toBeNull();
    expect(soleFairDay({ startDate: '2026-09-07', endDate: '2026-09-09' }, '2026-09-08')).toBeNull();
  });
});

describe('fairDayCheck — what the submit check is asked about the day', () => {
  const event = (day: string | null) =>
    fairEditPatch({ venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09', day });

  it('a create that picked an event sends it, so a missing day is caught', () => {
    expect(fairDayCheck(event(null), {}))
      .toEqual({ fairOrganizer: 'MLE', fairStart: '2026-08-08', fairEnd: '2026-08-09', fairDate: null });
  });

  it('a create with no event, or a place alone, sends nothing to check', () => {
    expect(fairDayCheck(fairEditPatch(null), {})).toEqual({});
  });

  it('an old order opened and left alone is not asked for a day it was saved without', () => {
    expect(fairDayCheck(event(null), event(null))).toEqual({});
    /* The phone seeds the venue from the master's spelling. */
    expect(fairDayCheck({ ...event(null), fairVenue: 'Mid Valley' }, event(null))).toEqual({});
  });

  it('an edit that changes the event, or clears the day, is checked', () => {
    expect(fairDayCheck(event(null), event('2026-08-08'))).toMatchObject({ fairDate: null });
    expect(fairDayCheck(event('2026-08-09'), event('2026-08-08'))).toMatchObject({ fairDate: '2026-08-09' });
  });
});
