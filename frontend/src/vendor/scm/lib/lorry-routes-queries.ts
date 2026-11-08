// Each lorry's day by road (owner 2026-11-08): home -> stops in order -> home, distance
// and driving time from Google. The SERVER works the runs out (scm/lib/lorry-day-runs.ts,
// nightly and when Last Mile opens a day); every page only reads its figures.
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

/** One stop's drive from the stop before (the first from home); `ref` null is the drive home. */
export type RoadLeg = { ref: string | null; distanceM: number; durationS: number };
export type RoadFigure = { lorryId: string; date: string; distanceM: number; durationS: number; stopCount: number; polyline: string | null; legs: RoadLeg[] | null };

/** "86.4 km" — one decimal under 100 km, whole above. PURE. */
export const fmtKm = (m: number): string => { const km = m / 1000; return `${km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString()} km`; };
/** "3 h 10 min" / "45 min". PURE. */
export const fmtDrive = (s: number): string => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };
/** Last Mile: the server works the day's runs out now (Google only for a run that
 *  changed) and returns every lorry's figure, by lorry id. */
export function useRoadDay(date: string) {
  return useQuery({
    queryKey: ['lorry-route', 'day', date],
    queryFn: () => authedFetch<{ routes: RoadFigure[] }>('/lorry-routes/day', { method: 'POST', body: JSON.stringify({ date }) })
      .then((x) => new Map(x.routes.map((r) => [r.lorryId, r]))),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The kept figures for a period (Lorry Capacity, Fleet Health). */
export function useRoadFigures(from: string, to: string, lorryId: string | null) {
  return useQuery({
    queryKey: ['lorry-route', 'range', from, to, lorryId],
    queryFn: () => authedFetch<{ routes: RoadFigure[] }>(`/lorry-routes?from=${from}&to=${to}${lorryId ? `&lorryId=${lorryId}` : ''}`).then((x) => x.routes),
    staleTime: 60_000,
  });
}

/** Per-lorry totals over the figures. PURE. */
export function roadTotalsByLorry(rows: readonly RoadFigure[]): Map<string, { distanceM: number; durationS: number; days: number }> {
  const out = new Map<string, { distanceM: number; durationS: number; days: number }>();
  for (const r of rows) {
    const t = out.get(r.lorryId) ?? { distanceM: 0, durationS: 0, days: 0 };
    t.distanceM += r.distanceM; t.durationS += r.durationS; t.days += 1;
    out.set(r.lorryId, t);
  }
  return out;
}

/** "12.0 km · 18 min" for each order on the day's runs, by sales order number. PURE. */
export function legLabelsByRef(figs: Iterable<RoadFigure>): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of figs) for (const l of f.legs ?? []) if (l.ref) out.set(l.ref, `${fmtKm(l.distanceM)} · ${fmtDrive(l.durationS)}`);
  return out;
}

/** One lorry-day, Google against what really happened (server: scm/lib/lorry-day-stats.ts).
 *  `driveS` and `googleTimedS` cover the same timed stops, so they compare like for like. */
export type RoadDayStat = {
  date: string; lorryId: string;
  googleM: number; googleS: number; gpsKm: number | null;
  stops: number; timedStops: number; driveS: number; googleTimedS: number;
  onSiteS: number; onSiteStops: number;
};
export type OnSiteRow = { buildingType: string; lorryId: string; stops: number; onSiteS: number };

export function useRoadDaily(from: string, to: string) {
  return useQuery({
    queryKey: ['lorry-route', 'daily', from, to],
    queryFn: () => authedFetch<{ days: RoadDayStat[]; onSite: OnSiteRow[] }>(`/lorry-routes/daily?from=${from}&to=${to}`),
    staleTime: 60_000,
  });
}

/** "+12%" / "-8%" against the Google figure; null when there is nothing to compare. PURE. */
export function diffPct(actual: number | null, google: number): string | null {
  if (actual == null || google <= 0) return null;
  const p = Math.round(((actual - google) / google) * 100);
  return `${p > 0 ? '+' : ''}${p}%`;
}

/** Per-lorry totals of the daily figures. GPS km stays null for a lorry with no GPS day. PURE. */
export function dailyTotalsByLorry(days: readonly RoadDayStat[]): Map<string, { gpsKm: number | null; driveS: number; googleTimedS: number; timedStops: number }> {
  const out = new Map<string, { gpsKm: number | null; driveS: number; googleTimedS: number; timedStops: number }>();
  for (const d of days) {
    const t = out.get(d.lorryId) ?? { gpsKm: null, driveS: 0, googleTimedS: 0, timedStops: 0 };
    if (d.gpsKm != null) t.gpsKm = (t.gpsKm ?? 0) + d.gpsKm;
    t.driveS += d.driveS; t.googleTimedS += d.googleTimedS; t.timedStops += d.timedStops;
    out.set(d.lorryId, t);
  }
  return out;
}
