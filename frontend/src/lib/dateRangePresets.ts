
export type RangePresetKey =
  | 'today'
  | 'last7'
  | 'thisMonth'
  | 'lastMonth'
  | 'last3Months'
  | 'last12Months'
  | 'thisYear'
  | 'thisQuarter'
  | 'lastQuarter'
  | 'yearToDate'
  | 'lastYear'
  | 'nextMonth'
  | 'nextQuarter'
  | 'next12Months'
  | 'wholeMonth'
  | 'wholeQuarter'
  | 'wholeYear'
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

/** The first day of the quarter `n` quarters after the one `iso` falls in. */
export const quarterStart = (iso: string, n = 0): string =>
  isoOfMs(Date.UTC(Number(iso.slice(0, 4)), Math.floor((Number(iso.slice(5, 7)) - 1) / 3) * 3 + n * 3, 1));

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
    case 'thisQuarter': return 'This quarter';
    case 'lastQuarter': return 'Last quarter';
    case 'yearToDate': return 'Year to date';
    case 'lastYear': return 'Last year';
    case 'nextMonth': return 'Next month';
    case 'nextQuarter': return 'Next quarter';
    case 'next12Months': return 'Next 12 months';
    case 'wholeMonth': return 'This month';
    case 'wholeQuarter': return 'This quarter';
    case 'wholeYear': return 'This year';
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
    case 'last12Months': return { from: addDays(today, -365), to: today };
    case 'thisYear': return { from: isoOfMs(Date.UTC(Number(today.slice(0, 4)), 0, 1)), to: today };
    case 'thisQuarter': return { from: quarterStart(today), to: today };
    case 'lastQuarter': return { from: quarterStart(today, -1), to: addDays(quarterStart(today), -1) };
    case 'yearToDate': return { from: isoOfMs(Date.UTC(Number(today.slice(0, 4)), 0, 1)), to: today };
    case 'lastYear': return { from: isoOfMs(Date.UTC(Number(today.slice(0, 4)) - 1, 0, 1)), to: isoOfMs(Date.UTC(Number(today.slice(0, 4)) - 1, 11, 31)) };
    case 'nextMonth': return { from: monthStart(today, 1), to: monthEnd(today, 1) };
    case 'nextQuarter': return { from: quarterStart(today, 1), to: addDays(quarterStart(today, 2), -1) };
    case 'next12Months': return { from: today, to: addDays(today, 365) };
    /* The whole of this month / quarter / year, days still to come included -
       an event booked for next week belongs to this month (owner 2026-11-19). */
    case 'wholeMonth': return { from: monthStart(today), to: monthEnd(today) };
    case 'wholeQuarter': return { from: quarterStart(today), to: addDays(quarterStart(today, 1), -1) };
    case 'wholeYear': return { from: isoOfMs(Date.UTC(Number(today.slice(0, 4)), 0, 1)), to: isoOfMs(Date.UTC(Number(today.slice(0, 4)), 11, 31)) };
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

/** The Finance reports' presets (the design's report toolbar, batch 6 §4.1):
 *  Journal entries and the General ledger open on This month. */
export const REPORT_RANGE_PRESETS: readonly RangePresetKey[] = [
  'thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'yearToDate', 'last12Months', 'lastYear',
];

/** Project Overview's presets: this month / quarter / year run to their LAST
 *  day, since events still to come carry their forecast (owner 2026-11-19:
 *  下个礼拜的 project 没进来), then the months ahead (owner 2026-11-18). */
export const PROJECT_REPORT_RANGE_PRESETS: readonly RangePresetKey[] = [
  'wholeMonth', 'lastMonth', 'wholeQuarter', 'lastQuarter', 'wholeYear', 'yearToDate', 'last12Months', 'lastYear',
  'nextMonth', 'nextQuarter', 'next12Months',
];
