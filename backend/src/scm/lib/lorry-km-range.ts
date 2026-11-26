
import { paginateAll } from './paginate-all';
import { mapBounded } from './concurrency';
import { kmFromFixes, myDayWindow, odometerKm, oneTracker, type Fix } from './lorry-km';

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

/** odoKm: odometer km per lorry, only for lorries with two or more odometer readings that day. */
export type DayKm = { error: string | null; truncated: boolean; km: Map<string, number>; odoKm: Map<string, number> };

export async function kmForDay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scm-scoped supabase-js client
  sb: any,
  day: string,
): Promise<DayKm> {
  const win = myDayWindow(day);
  if (!win) return { error: null, truncated: false, km: new Map(), odoKm: new Map() };
  // company-scope: UNIFIED FLEET — one shared fleet across all companies (lorries.ts:132), like /lorries/km-cost.
  const { data, error, truncated } = await paginateAll<Fix & { lorry_id: string; device_id: string | null; odometer_m: number | null }>((lo, hi) =>
    sb.from('lorry_positions')
      .select('lorry_id, device_id, lat, lng, recorded_at, odometer_m')
      .gte('recorded_at', win.from).lt('recorded_at', win.to)
      .order('recorded_at').order('id')
      .range(lo, hi));
  if (error) return { error: error.message, truncated: false, km: new Map(), odoKm: new Map() };
  const byLorry = new Map<string, Array<Fix & { device_id: string | null; odometer_m: number | null }>>();
  for (const f of data ?? []) {
    const list = byLorry.get(f.lorry_id) ?? [];
    list.push(f);
    byLorry.set(f.lorry_id, list);
  }
  const odoKm = new Map<string, number>();
  for (const [lid, list] of byLorry) {
    const o = odometerKm(list);
    if (o != null) odoKm.set(lid, o);
  }
  return { error: null, truncated, km: new Map([...byLorry].map(([lid, list]) => [lid, kmFromFixes(oneTracker(list))])), odoKm };
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
