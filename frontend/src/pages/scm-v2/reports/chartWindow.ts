// ----------------------------------------------------------------------------
// chartWindow — which months a report chart shows (the owner's Claude Design,
// batch 6 §4.1): twelve, or up to twenty-four for a longer range, ending with
// the range's last month. The window stays put while the chosen period sits
// inside it — clicking a month only opens that month — and moves only when
// the period falls outside it, to the nearest edge.
// Months are ISO first-of-month days (`2026-10-01`).
// ----------------------------------------------------------------------------

import { monthStart } from '../../../lib/dateRangePresets';

export type ChartWindow = { from: string; to: string };

/** Months from `a` to `b`, both counted (a month to itself is 1). */
export const monthsBetween = (a: string, b: string): number =>
  (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1;

/** Every month of a window, oldest first. */
export const windowMonths = (w: ChartWindow): string[] =>
  Array.from({ length: Math.max(0, monthsBetween(w.from, w.to)) }, (_, i) => monthStart(w.from, i));

/** The window for a range, given the one shown before it (null on first draw). */
export function nextChartWindow(prev: ChartWindow | null, rangeFrom: string, rangeTo: string): ChartWindow {
  const first = monthStart(rangeFrom);
  const last = monthStart(rangeTo);
  const span = monthsBetween(first, last);
  const length = span > 12 ? Math.min(span, 24) : 12;
  const ending = (end: string): ChartWindow => ({ from: monthStart(end, -(length - 1)), to: end });
  if (!prev || monthsBetween(prev.from, prev.to) !== length) return ending(last);
  if (first >= prev.from && last <= prev.to) return prev;
  if (last > prev.to) return ending(last);
  return { from: first, to: monthStart(first, length - 1) };
}
