// The booths an order can be linked or moved to by hand, and the one to fill in
// (owner 2026-10-20: 「我要 link fair 时无法知道 brand」). Shared by Fair Links and
// the project page's Sales Orders, so the two offer the same choices in the
// same order. Pure.

import { fairLabel, type FairOption, type FairPendingRow } from './fair-options-queries';

/** One choice: ONE booth — a brand at one event. */
export type BoothChoice = { projectId: number; label: string; sameBrand: boolean };

/** Case/space-insensitive, as every venue and brand compare on the server. */
const norm = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayNo = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** Days between the order's date and the fair's period: 0 inside it. */
function daysFrom(o: Pick<FairOption, 'startDate' | 'endDate'>, soDate: string | null): number {
  if (!soDate || !ISO.test(soDate) || !ISO.test(o.startDate)) return 0;
  const d = dayNo(soDate);
  const start = dayNo(o.startDate);
  const end = dayNo(o.endDate && ISO.test(o.endDate) ? o.endDate : o.startDate);
  if (d < start) return start - d;
  if (d > end) return d - end;
  return 0;
}

/**
 * The booths an order can be linked to, and the one to fill in.
 *
 * Only fairs at the venue the order already records — the place is evidence
 * from the floor; a hand pick decides WHICH BOOTH, never where the sale
 * happened. Each reads BRAND — VENUE — ORGANIZER (dates). The order's own brand
 * comes first, then the rest; in each, the fair nearest the order's date first.
 * Two records of one booth (same brand at one event) show once, as the lowest
 * id — the arbiter the server's resolver uses (fair-options.ts
 * oneBoothOrNothing); booths with no brand cannot be told apart, so they are
 * never merged.
 *
 * `suggested` is the order's-brand booth nearest its date, or null when the
 * order has no brand or its brand has no booth there.
 */
export function boothChoices(
  options: readonly FairOption[],
  order: Pick<FairPendingRow, 'venue' | 'branding' | 'so_date'>,
): { choices: BoothChoice[]; suggested: number | null } {
  const brand = norm(order.branding);
  const soDate = order.so_date ? order.so_date.slice(0, 10) : null;
  const byBooth = new Map<string, { choice: BoothChoice; days: number; start: string; brand: string }>();
  for (const o of options) {
    if (norm(o.venue) !== norm(order.venue)) continue;
    const booths = o.booths ?? o.projectIds.map((projectId) => ({ projectId, brand: null }));
    for (const b of booths) {
      const key = b.brand ? `${o.key}|${norm(b.brand)}` : `${o.key}|#${b.projectId}`;
      const seen = byBooth.get(key);
      if (seen && seen.choice.projectId <= b.projectId) continue;
      byBooth.set(key, {
        choice: { projectId: b.projectId, label: `${b.brand || 'No brand'} — ${fairLabel(o)}`, sameBrand: brand !== '' && norm(b.brand) === brand },
        days: daysFrom(o, soDate),
        start: o.startDate,
        brand: norm(b.brand),
      });
    }
  }
  const choices = [...byBooth.values()]
    .sort((a, b) =>
      Number(b.choice.sameBrand) - Number(a.choice.sameBrand) ||
      a.days - b.days ||
      b.start.localeCompare(a.start) ||
      (a.brand === '' ? 1 : 0) - (b.brand === '' ? 1 : 0) ||
      a.brand.localeCompare(b.brand) ||
      a.choice.projectId - b.choice.projectId)
    .map((x) => x.choice);
  return { choices, suggested: choices[0]?.sameBrand ? choices[0].projectId : null };
}
