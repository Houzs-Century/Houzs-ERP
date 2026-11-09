// ----------------------------------------------------------------------------
// dates — Malaysia-calendar date helpers for form defaults.
//
// `new Date().toISOString().slice(0, 10)` is the UTC calendar date; Malaysia
// is UTC+8, so before 08:00 MYT it returns YESTERDAY — every "today" form
// default (doc dates, payment dates, filter ranges) was a day off each
// morning. Mirror of `todayMY()` (SoFromProducts.tsx): shift the clock +8h,
// then read the UTC date — that IS the Malaysian calendar date, regardless of
// the browser's own timezone.
// ----------------------------------------------------------------------------

/** Today's calendar date in Malaysia (UTC+8) as `YYYY-MM-DD`.
 *  Optional `offsetDays` shifts the result (e.g. `todayMyt(-365)` = a year ago). */
export const todayMyt = (offsetDays = 0): string =>
  new Date(Date.now() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000)
    .toISOString().slice(0, 10);

/** The Malaysian (UTC+8) calendar day a given instant falls on, as `YYYY-MM-DD`.
 *  Frontend mirror of the backend `mytDateOf()` (scm/lib/my-time.ts).
 *
 *  Returns null when the instant is missing or unparseable. Deliberately NOT
 *  `?? todayMyt()` or `?? ''`: a date we could not read is an error for the
 *  caller to surface, and defaulting it would either silently unlock a control
 *  or silently deny one — both of which lie to the operator about why. */
export const mytDayOf = (instant: string | null | undefined): string | null => {
  if (!instant) return null;
  const t = new Date(instant).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
};

const VALUE_DAY = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?/i;

/** The Malaysian calendar day a stored value stands for, as `YYYY-MM-DD` —
 *  what every date filter judges a row by (owner 2026-11-09).
 *
 *  A plain DATE (`2026-11-10`, `2026/11/10`) is already a calendar day and is
 *  returned as written. A timestamp carrying an offset (`2026-11-09T17:30:00Z`,
 *  `…+00:00`, Postgres' `… 17:30:00+00`) is an instant, and its first ten
 *  characters are the UTC day: 01:30 in Malaysia on the 10th read as the 9th,
 *  so it goes through `mytDayOf`. A timestamp with no offset says nothing about
 *  its zone, so it is read as the wall clock it shows. null when the value does
 *  not start with a date. */
export const mytDayOfValue = (value: string | number | null | undefined): string | null => {
  if (value == null) return null;
  const m = VALUE_DAY.exec(String(value).trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const [, , , , time, zone] = m;
  if (!time || !zone) return day;
  const offset = /^z$/i.test(zone) ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return mytDayOf(`${day}T${time}${offset}`) ?? day;
};

/** True when the given instant (UTC ISO string) falls on the current Malaysian
 *  calendar day — drives the same-day payment EDIT affordance. Uses the same
 *  +8h shift as `todayMyt()` so both sides agree regardless of the browser zone. */
export const isCreatedTodayMyt = (createdAt: string | null | undefined): boolean => {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10) === todayMyt();
};

/** A stored instant (TIMESTAMPTZ ISO, e.g. a driver's "Arrived" stamp) → the
 *  Malaysian wall clock `YYYY-MM-DDTHH:mm` that DateTimeField reads. Slicing the
 *  ISO string instead printed the UTC clock: an 11:00 arrival showed as 03:00.
 *  '' when missing or unparseable. */
export const instantToMytLocal = (instant: string | null | undefined): string => {
  if (!instant) return '';
  const t = new Date(instant).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 16);
};

/** A Malaysian wall clock `YYYY-MM-DDTHH:mm` typed in DateTimeField → the
 *  instant to store, with its +08:00 offset written out. Sent bare, Postgres
 *  read it as UTC and the office's 11:00 landed 8 hours from the driver's own
 *  stamps. null when empty. */
export const mytLocalToInstant = (local: string | null | undefined): string | null => {
  const v = (local ?? '').trim();
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00+08:00` : v;
};
