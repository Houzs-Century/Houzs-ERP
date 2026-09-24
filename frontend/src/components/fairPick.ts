// What a Fair pick means on an EDIT save. One copy for the desktop SO page and
// the phone editor, which differ only in how they hold form state.
//
// Owner 2026-09-24: 「我选了那个场（Mid Valley，MLE，8 号到 9 号），选了过后，它就自动
// 记下是那个场地的，包括 venue, organiser 和那个日期」. The picked EVENT travels with
// the save and the server links exactly that event; a place alone (Others) still
// leaves the link to the next morning's reconcile.
//
// And the DAY of it (owner 2026-09-24): the event runs 7-9, 「他一选完那个 event，这边
// 下拉菜单就要拉出来 7、8、9 三天给他选」. The day is part of the pick: it travels
// with its event and is cleared whenever the event changes.

import type { FairPickValue } from './FairPicker';
import type { LinkedFair } from '../vendor/scm/lib/fair-options-queries';

export type { LinkedFair };

/** The event half of a pick, plus the DAY of it the order was written on (null
 *  until one is picked). Null for a place alone: Others, a clear, or an order
 *  with no fair link. */
export type FairEvent = Pick<LinkedFair, 'venue' | 'organizer' | 'startDate' | 'endDate'> & { day: string | null };

const normText = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const sameText = (a: string, b: string) => normText(a) === normText(b);

export function fairEventOf(v: FairPickValue): FairEvent | null {
  return v.venue && v.organizer && v.startDate
    ? { venue: v.venue, organizer: v.organizer, startDate: v.startDate, endDate: v.endDate, day: v.day }
    : null;
}

/** The order's linked event, spelled with the ORDER's venue so an untouched
 *  picker saves byte-identical values and never re-sends the fair. Null when the
 *  link names another place: 5 of 95 linked orders on 2026-09-24 had an automatic
 *  link to a fair at a venue other than the one on the order, and showing that
 *  event under the order's venue would present a contradiction as one answer.
 *  `day` is the order's own `fair_date`, passed explicitly (null when none). */
export function linkedEvent(
  orderVenue: string | null,
  linked: LinkedFair | null | undefined,
  day: string | null,
): FairEvent | null {
  if (!orderVenue || !linked || !sameText(orderVenue, linked.venue)) return null;
  return { venue: orderVenue, organizer: linked.organizer, startDate: linked.startDate, endDate: linked.endDate, day };
}

/** The picker's value for a form: the order's venue plus the event, when there is one. */
export function fairPickValue(venue: string | null, event: FairEvent | null): FairPickValue {
  return {
    venue,
    organizer: event?.organizer ?? null,
    startDate: event?.startDate ?? null,
    endDate: event?.endDate ?? null,
    day: event?.day ?? null,
  };
}

/** The keys an edit save ALWAYS carries — the picked event and its day, or nulls.
 *  Always all five, so the seeded-vs-current header diff sends them only when the
 *  pick changed, and a switch to Others (nulls) is a change like any other. */
export function fairEditPatch(event: FairEvent | null): {
  fairVenue: string | null; fairOrganizer: string | null; fairStart: string | null; fairEnd: string | null; fairDate: string | null;
} {
  return {
    fairVenue: event?.venue ?? null,
    fairOrganizer: event?.organizer ?? null,
    fairStart: event?.startDate ?? null,
    fairEnd: event?.endDate ?? null,
    fairDate: event?.day ?? null,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A runaway period (a mistyped end date) must not build a list nobody can use. */
const MAX_FAIR_DAYS = 400;

/**
 * Every day of the event, `YYYY-MM-DD`, first to last (a missing end is one day,
 * as on the server), stopping at `cap` — the ORDER date the fair list was built
 * for (`FairOptionsResponse.date`). A day after it has not happened yet when the
 * order was keyed: *"日期还没到，还没开单，不可能嘛"*. The server keeps a day only
 * inside the same bounds (`fair-options.ts::fairDayOnSave`).
 *
 * Day arithmetic goes through `Date.UTC` on the PARTS, so no value is an instant
 * in a zone and the calendar date survives.
 */
export function fairDaysOf(
  event: Pick<FairPickValue, 'startDate' | 'endDate'>,
  cap: string | null,
): string[] {
  const start = (event.startDate ?? '').slice(0, 10);
  if (!ISO_DATE.test(start)) return [];
  const endRaw = (event.endDate ?? '').slice(0, 10);
  const capDay = (cap ?? '').slice(0, 10);
  let last = ISO_DATE.test(endRaw) && endRaw > start ? endRaw : start;
  if (ISO_DATE.test(capDay) && capDay < last) last = capDay;
  const [y, m, d] = [Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10))];
  const out: string[] = [];
  for (let i = 0; i < MAX_FAIR_DAYS; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (day > last) break;
    out.push(day);
  }
  return out;
}

/** The day to fill in on its own: the only one there is to pick (a one-day fair,
 *  or the first day of a fair still running). Several days is the operator's
 *  answer to give, so null — 73 of 101 event orders dated from 2026-08-25 were
 *  keyed after their fair had closed, so "today" is usually not the day. */
export function soleFairDay(event: Pick<FairPickValue, 'startDate' | 'endDate'>, cap: string | null): string | null {
  const days = fairDaysOf(event, cap);
  return days.length === 1 ? days[0]! : null;
}

/** The fair keys of a header payload, as `fairEditPatch` builds them. */
type FairKeys = Partial<Record<keyof ReturnType<typeof fairEditPatch>, unknown>>;

/** The fair keys for the submit check (`POST /mfg-sales-orders/validate`), which
 *  asks for a missing day. Sent only when `now` picked or changed the event or
 *  its day against `was` (what the form opened with; nulls on a create), so an
 *  order saved before days were recorded is not blocked when left alone. The
 *  venue compares loosely: the phone seeds it from the venue master's spelling,
 *  which can differ from the order's text in case and spacing. */
export function fairDayCheck(now: FairKeys, was: FairKeys): Record<string, string | null> {
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const key = (k: FairKeys) =>
    [normText(text(k.fairVenue)), normText(text(k.fairOrganizer)), text(k.fairStart), text(k.fairEnd), text(k.fairDate)].join('|');
  if (key(now) === key(was)) return {};
  return {
    fairOrganizer: text(now.fairOrganizer) || null,
    fairStart: text(now.fairStart) || null,
    fairEnd: text(now.fairEnd) || null,
    fairDate: text(now.fairDate) || null,
  };
}
