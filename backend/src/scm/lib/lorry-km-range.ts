// GPS km per lorry over a date range, read ONE MALAYSIA DAY AT A TIME.
//
// A whole month in one paged read (~288 fixes per tracked lorry per day) passes
// paginateAll's 50-page guard at about 6 lorries, and that guard used to stop
// silently: the fixes are ordered by time, so the last days of the month simply
// went missing and km / running cost came out low with no error. One day per
// read keeps each read far below the guard (about 170 lorries per day).
//
// The per-day sum differs from one continuous read only by a hop that crosses
// midnight, which /lorries/km-cost (one day) already drops; lorries are parked then.
//
// Answers are complete or say why not: a range longer than KM_MAX_DAYS, or a day
// whose read hit the guard, returns `incomplete` and no km at all, so the
// dashboard shows a dash instead of a number that is too small.

import { paginateAll } from './paginate-all';
import { mapBounded } from './concurrency';
import { kmFromFixes, myDayWindow, type Fix } from './lorry-km';

/** One read per day, so the range bounds the subrequests one dashboard load spends. */
export const KM_MAX_DAYS = 62;
const DAY_CONCURRENCY = 4;

export type KmRange =
  | { ok: true; km: Map<string, number> }
  | { ok: true; km: null; incomplete: string }
  | { ok: false; error: string };

/** The YYYY-MM-DD days from..to inclusive; [] when either end is not a real date. */
export function daysInRange(from: string, to: string): string[] {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return [];
  const out: string[] = [];
  for (let t = a; t <= b; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

type DayKm = { error: string | null; truncated: boolean; km: Map<string, number> };

async function kmForDay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  day: string,
): Promise<DayKm> {
  const win = myDayWindow(day);
  if (!win) return { error: null, truncated: false, km: new Map() };
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), like /lorries/km-cost.
  const { data, error, truncated } = await paginateAll<Fix & { lorry_id: string }>((lo, hi) =>
    sb.from('lorry_positions')
      .select('lorry_id, lat, lng, recorded_at')
      .gte('recorded_at', win.from).lt('recorded_at', win.to)
      .order('recorded_at').order('id')
      .range(lo, hi));
  if (error) return { error: error.message, truncated: false, km: new Map() };
  const byLorry = new Map<string, Fix[]>();
  for (const f of data ?? []) {
    const list = byLorry.get(f.lorry_id) ?? [];
    list.push(f);
    byLorry.set(f.lorry_id, list);
  }
  return { error: null, truncated, km: new Map([...byLorry].map(([lid, list]) => [lid, kmFromFixes(list)])) };
}

export async function kmByLorryForRange(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  from: string,
  to: string,
): Promise<KmRange> {
  const days = daysInRange(from, to);
  if (days.length > KM_MAX_DAYS) {
    return { ok: true, km: null, incomplete: `GPS km is worked out for at most ${KM_MAX_DAYS} days; narrow the range.` };
  }
  const perDay = await mapBounded(days, DAY_CONCURRENCY, (day) => kmForDay(sb, day));
  const km = new Map<string, number>();
  for (let i = 0; i < perDay.length; i++) {
    const d = perDay[i]!;
    if (d.error) return { ok: false, error: d.error };
    if (d.truncated) return { ok: true, km: null, incomplete: `Too many GPS fixes on ${days[i]} to read in full.` };
    for (const [lid, k] of d.km) km.set(lid, (km.get(lid) ?? 0) + k);
  }
  for (const [lid, k] of km) km.set(lid, Math.round(k * 10) / 10);
  return { ok: true, km };
}
