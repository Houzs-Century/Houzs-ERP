// dateRangePresets — the presets a Finance date-range picker offers
// (components/DateRangeButton) and the day arithmetic behind them.
//
// ONE home for them (the owner's redesign, batch 5 and batch 6): Money in ›
// Outstanding uses the presets below, and the reports add theirs here rather
// than in a second list. A preset is a key, a label and a rule that turns
// "today" into a range.
//
// Dates are ISO `YYYY-MM-DD` strings — the shape the API takes — and '' is an
// open end. The arithmetic runs on UTC midnights, so a calendar day never moves
// with the browser's time zone. Nothing here formats a date for a reader: that
// is fmtDate's job.

export type RangePresetKey =
  | 'today'
  | 'last7'
  | 'thisMonth'
  | 'lastMonth'
  | 'last3Months'
  | 'last12Months'
  | 'thisYear'
  | 'all';

export type DateRange = { from: string; to: string };

const DAY_MS = 86_400_000;

const msOf = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const isoOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** True for a real calendar day written `YYYY-MM-DD` (2026-02-30 is not). */
export const isIsoDay = (v: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(msOf(v)) && isoOfMs(msOf(v)) === v;

/** `iso` moved by `n` days. */
export const addDays = (iso: string, n: number): string => isoOfMs(msOf(iso) + n * DAY_MS);

/** The first day of the month `n` months after the month `iso` falls in. */
export const monthStart = (iso: string, n = 0): string =>
  isoOfMs(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 + n, 1));

/** The last day of that month. */
export const monthEnd = (iso: string, n = 0): string => addDays(monthStart(iso, n + 1), -1);

/** Days from `from` to `to` (negative when `to` is earlier). */
export const dayDiff = (from: string, to: string): number => Math.round((msOf(to) - msOf(from)) / DAY_MS);

/** Days in the range, both ends counted: a single day is 1. */
export const daysInRange = (from: string, to: string): number => dayDiff(from, to) + 1;

export function presetLabel(key: RangePresetKey): string {
  switch (key) {
    case 'today': return 'Today';
    case 'last7': return 'Last 7 days';
    case 'thisMonth': return 'This month';
    case 'lastMonth': return 'Last month';
    case 'last3Months': return 'Last 3 months';
    case 'last12Months': return 'Last 12 months';
    case 'thisYear': return 'This year';
    case 'all': return 'All dates';
  }
}

/** The range a preset stands for, counted back from `today`. */
export function presetRange(key: RangePresetKey, today: string): DateRange {
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'thisMonth': return { from: monthStart(today), to: today };
    case 'lastMonth': return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case 'last3Months': return { from: monthStart(today, -2), to: today };
    /* A year back to the day — the window Outstanding has always opened on
       (it read todayMyt(-365) before the redesign), so an invoice unpaid for
       eleven months still shows without anyone touching the dates. */
    case 'last12Months': return { from: addDays(today, -365), to: today };
    case 'thisYear': return { from: isoOfMs(Date.UTC(Number(today.slice(0, 4)), 0, 1)), to: today };
    /* No from, no to: the page sends neither and the server reads every date. */
    case 'all': return { from: '', to: '' };
  }
}

/** The first of `keys` whose range this is, or null. */
export function presetOf(range: DateRange, keys: readonly RangePresetKey[], today: string): RangePresetKey | null {
  for (const k of keys) {
    const r = presetRange(k, today);
    if (r.from === range.from && r.to === range.to) return k;
  }
  return null;
}

/** Outstanding's presets: the design's seven plus Last 12 months, the default
 *  until the owner answers question f7 (the design opens on Last 3 months). */
export const OUTSTANDING_RANGE_PRESETS: readonly RangePresetKey[] = [
  'today', 'last7', 'thisMonth', 'lastMonth', 'last3Months', 'last12Months', 'thisYear', 'all',
];
export const OUTSTANDING_DEFAULT_PRESET: RangePresetKey = 'last12Months';
