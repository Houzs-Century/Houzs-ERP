/* What a Fair pick means on an EDIT save (owner 2026-09-24): 「我选了那个场（Mid Valley，
 * MLE，8 号到 9 号），选了过后，它就自动记下是那个场地的，包括 venue, organiser 和那个
 * 日期」. The desktop SO page and the phone editor both diff a SEEDED header payload
 * against the current one (so-header-diff.ts), so the property that matters is
 * what that diff sends: nothing when the picker is untouched, the four fair keys
 * when another event is picked, nulls when the operator falls back to Others.
 */
import { describe, expect, it } from 'vitest';
import { diffHeaderPayload } from '../vendor/scm/lib/so-header-diff';
import { fairEditPatch, fairEventOf, fairPickValue, linkedEvent, type LinkedFair } from './fairPick';

const MLE: LinkedFair = { venue: 'MID VALLEY', organizer: 'MLE', solo: false, startDate: '2026-08-08', endDate: '2026-08-09' };

/* One edit session, both surfaces' shape: the baseline is built from the loaded
   order, the outgoing payload from whatever the picker now holds. */
const session = (orderVenue: string | null, linked: LinkedFair | null) => {
  const seeded = fairPickValue(orderVenue, linkedEvent(orderVenue, linked));
  const baseline = fairEditPatch(linkedEvent(orderVenue, linked));
  return { seeded, sent: (picker: typeof seeded) => diffHeaderPayload(baseline, fairEditPatch(fairEventOf(picker))) };
};

describe('an edit save and the Fair picker', () => {
  it('an untouched picker sends nothing — linked or not', () => {
    const linked = session('MID VALLEY', MLE);
    expect(linked.sent(linked.seeded)).toEqual({});
    const unlinked = session('SPICE ARENA', null);
    expect(unlinked.sent(unlinked.seeded)).toEqual({});
  });

  it('a recorded pick reads back as its event: venue, organizer and dates', () => {
    expect(session('MID VALLEY', MLE).seeded).toEqual({ venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09' });
  });

  it('picking another event sends that event whole', () => {
    const s = session('MID VALLEY', MLE);
    const bighome = { venue: 'MID VALLEY', organizer: 'BIGHOME', startDate: '2026-08-15', endDate: '2026-08-17' };
    expect(s.sent(bighome)).toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'BIGHOME', fairStart: '2026-08-15', fairEnd: '2026-08-17' });
  });

  it('the unchanged parts of the new event travel too — never half an event', () => {
    /* Same venue and end date as the linked MLE fair, another organizer and
       start. Sent by halves, the server would read the missing end as a
       one-day fair and match nothing. */
    const s = session('MID VALLEY', MLE);
    expect(s.sent({ venue: 'MID VALLEY', organizer: 'REX', startDate: '2026-08-07', endDate: '2026-08-09' }))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'REX', fairStart: '2026-08-07', fairEnd: '2026-08-09' });
  });

  it('backfilling an order that had no event sends the picked one', () => {
    const s = session(null, null);
    expect(s.sent({ venue: 'MID VALLEY', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09' }))
      .toEqual({ fairVenue: 'MID VALLEY', fairOrganizer: 'MLE', fairStart: '2026-08-08', fairEnd: '2026-08-09' });
  });

  it('falling back to Others (a place alone) sends the event as cleared', () => {
    const s = session('MID VALLEY', MLE);
    expect(s.sent({ venue: 'IOI CITY MALL', organizer: null, startDate: null, endDate: null }))
      .toEqual({ fairVenue: null, fairOrganizer: null, fairStart: null, fairEnd: null });
  });
});

describe('linkedEvent — the link is shown only under its own venue', () => {
  it('matches the order venue case- and space-insensitively, spelled as the ORDER spells it', () => {
    expect(linkedEvent('Mid  Valley ', MLE)).toEqual({ venue: 'Mid  Valley ', organizer: 'MLE', startDate: '2026-08-08', endDate: '2026-08-09' });
  });

  it('a link to a fair at ANOTHER venue is not shown as this order\'s event', () => {
    /* HC-SO-2609-081 on 2026-09-24: venue KUALA LUMPUR CONVENTION CENTRE, linked to
       a fair at IOI MALL PUTRAJAYA. Showing that event under the order's venue
       would present a contradiction as one answer. */
    expect(linkedEvent('KUALA LUMPUR CONVENTION CENTRE', { ...MLE, venue: 'IOI MALL PUTRAJAYA' })).toBeNull();
  });

  it('no link, or no venue on the order, is no event', () => {
    expect(linkedEvent('MID VALLEY', null)).toBeNull();
    expect(linkedEvent('MID VALLEY', undefined)).toBeNull();
    expect(linkedEvent(null, MLE)).toBeNull();
  });
});

describe('fairEventOf', () => {
  it('a place alone is not an event', () => {
    expect(fairEventOf({ venue: 'MID VALLEY', organizer: null, startDate: null, endDate: null })).toBeNull();
    expect(fairEventOf({ venue: null, organizer: null, startDate: null, endDate: null })).toBeNull();
  });
});
