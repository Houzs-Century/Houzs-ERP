// What a Fair pick means on an EDIT save. One copy for the desktop SO page and
// the phone editor, which differ only in how they hold form state.
//
// Owner 2026-09-24: 「我选了那个场（Mid Valley，MLE，8 号到 9 号），选了过后，它就自动
// 记下是那个场地的，包括 venue, organiser 和那个日期」. The picked EVENT travels with
// the save and the server links exactly that event; a place alone (Others) still
// leaves the link to the next morning's reconcile.

import type { FairPickValue } from './FairPicker';
import type { LinkedFair } from '../vendor/scm/lib/fair-options-queries';

export type { LinkedFair };

/** The event half of a pick. Null for a place alone: Others, a clear, or an order
 *  with no fair link. */
export type FairEvent = Pick<LinkedFair, 'venue' | 'organizer' | 'startDate' | 'endDate'>;

const sameText = (a: string, b: string) =>
  a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export function fairEventOf(v: FairPickValue): FairEvent | null {
  return v.venue && v.organizer && v.startDate
    ? { venue: v.venue, organizer: v.organizer, startDate: v.startDate, endDate: v.endDate }
    : null;
}

/** The order's linked event, spelled with the ORDER's venue so an untouched
 *  picker saves byte-identical values and never re-sends the fair. Null when the
 *  link names another place: 5 of 95 linked orders on 2026-09-24 had an automatic
 *  link to a fair at a venue other than the one on the order, and showing that
 *  event under the order's venue would present a contradiction as one answer. */
export function linkedEvent(orderVenue: string | null, linked: LinkedFair | null | undefined): FairEvent | null {
  if (!orderVenue || !linked || !sameText(orderVenue, linked.venue)) return null;
  return { venue: orderVenue, organizer: linked.organizer, startDate: linked.startDate, endDate: linked.endDate };
}

/** The picker's value for a form: the order's venue plus the event, when there is one. */
export function fairPickValue(venue: string | null, event: FairEvent | null): FairPickValue {
  return { venue, organizer: event?.organizer ?? null, startDate: event?.startDate ?? null, endDate: event?.endDate ?? null };
}

/** The four keys an edit save ALWAYS carries — the picked event, or nulls. Always
 *  all four, so the seeded-vs-current header diff sends them only when the pick
 *  changed, and a switch to Others (nulls) is a change like any other. */
export function fairEditPatch(event: FairEvent | null): {
  fairVenue: string | null; fairOrganizer: string | null; fairStart: string | null; fairEnd: string | null;
} {
  return {
    fairVenue: event?.venue ?? null,
    fairOrganizer: event?.organizer ?? null,
    fairStart: event?.startDate ?? null,
    fairEnd: event?.endDate ?? null,
  };
}
