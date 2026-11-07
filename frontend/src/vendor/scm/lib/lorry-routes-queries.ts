// Each lorry's day by road (owner 2026-11-08): home -> stops in order -> home, distance
// and driving time from Google through POST /lorry-routes/estimate, which keeps the
// figure per lorry and day and asks Google again only when the run changes.
import { useQueries, useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';

export type RoadFigure = { lorryId: string; date: string; distanceM: number; durationS: number; stopCount: number; polyline: string | null };
export type RoadRunInput = { plate: string; home: { lat: number; lng: number }; stops: Array<{ lat: number; lng: number }> };

/** "86.4 km" — one decimal under 100 km, whole above. PURE. */
export const fmtKm = (m: number): string => { const km = m / 1000; return `${km < 100 ? km.toFixed(1) : Math.round(km).toLocaleString()} km`; };
/** "3 h 10 min" / "45 min". PURE. */
export const fmtDrive = (s: number): string => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`; };
/** The run's key: the same home and stops in the same order ask nothing new. PURE. */
export const runKey = (r: RoadRunInput): string => [r.home, ...r.stops].map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

/** One figure per lorry run on a day; a run with no home or no stops is skipped. */
export function useRoadRuns(date: string, runs: readonly RoadRunInput[]) {
  const results = useQueries({
    queries: runs.map((r) => ({
      queryKey: ['lorry-route', date, r.plate, runKey(r)],
      queryFn: () => authedFetch<{ route: RoadFigure }>('/lorry-routes/estimate', { method: 'POST', body: JSON.stringify({ date, ...r }) }).then((x) => x.route),
      staleTime: Infinity,
      retry: false,
    })),
  });
  return new Map(runs.map((r, i) => [r.plate, { figure: results[i]?.data ?? null, error: results[i]?.error ?? null, loading: results[i]?.isLoading ?? false }]));
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
