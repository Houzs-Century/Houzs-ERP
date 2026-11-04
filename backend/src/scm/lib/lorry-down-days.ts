// The days a lorry could not work, for Lorry Capacity and the Logistic Overview:
// its maintenance windows and every breakdown that took it off the road, from the
// day it stopped to the day it recovered (owner 2026-11-04: a lorry in the workshop
// has no capacity, so that day is not one it could have gone out). A day counts
// once when two of these overlap.
import { isCaseGrounding } from '../../services/fleet-status';

export type DownWindow = { lorryId: string; from: string; to: string };
export type DownCase = {
  lorry_id: string; severity: string; status: string; still_drivable: boolean | null;
  breakdown_start: string | null; occurred_at: string | null; recovery_time: string | null;
};

const myDate = (ts: string): string => new Date(Date.parse(ts) + 8 * 3600_000).toISOString().slice(0, 10);

/** One window per case that took the lorry off the road. A case resolved with no
 *  recovery time recorded counts its first day only: its end is unknown. */
export function breakdownWindows(cases: readonly DownCase[], today: string): DownWindow[] {
  const out: DownWindow[] = [];
  for (const c of cases) {
    const start = c.breakdown_start ?? c.occurred_at;
    if (!start || !isCaseGrounding({ severity: c.severity, status: 'OPEN', stillDrivable: c.still_drivable ?? true })) continue;
    const from = myDate(start);
    out.push({ lorryId: c.lorry_id, from, to: c.recovery_time ? myDate(c.recovery_time) : c.status === 'RESOLVED' ? from : today });
  }
  return out;
}

/** The working days (Mon to Sat) each lorry was down inside [from, to]. */
export function downDates(windows: readonly DownWindow[], from: string, to: string): Map<string, Set<string>> {
  const days = new Map<string, Set<string>>();
  for (const w of windows) {
    const start = w.from > from ? w.from : from;
    const end = w.to < to ? w.to : to;
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t);
      if (d.getUTCDay() === 0) continue;
      const seen = days.get(w.lorryId) ?? new Set<string>();
      seen.add(d.toISOString().slice(0, 10));
      days.set(w.lorryId, seen);
    }
  }
  return days;
}

/** How many working days each lorry was down inside [from, to]. */
export function downDays(windows: readonly DownWindow[], from: string, to: string): Map<string, number> {
  return new Map([...downDates(windows, from, to)].map(([id, s]) => [id, s.size]));
}

type Res<T> = { data: T[] | null; error: { message: string } | null };
type Reader = {
  from: (t: string) => {
    select: (c: string) => PromiseLike<Res<never>> & {
      lte: (c: string, v: string) => { gte: (c: string, v: string) => PromiseLike<Res<never>> };
    };
  };
};

/** Both sources for the period. Fleet tables are shared across companies. */
export async function loadDownWindows(sb: unknown, from: string, to: string, today: string): Promise<{ windows: DownWindow[]; error: string | null }> {
  const db = sb as Reader;
  const [m, b] = await Promise.all([
    db.from('lorry_maintenance').select('lorry_id, unavailable_from, unavailable_to').lte('unavailable_from', to).gte('unavailable_to', from) as PromiseLike<Res<{ lorry_id: string; unavailable_from: string; unavailable_to: string }>>,
    db.from('lorry_breakdown_cases').select('lorry_id, severity, status, still_drivable, breakdown_start, occurred_at, recovery_time') as PromiseLike<Res<DownCase>>,
  ]);
  return {
    error: m.error?.message ?? b.error?.message ?? null,
    windows: [
      ...(m.data ?? []).map((w) => ({ lorryId: w.lorry_id, from: w.unavailable_from.slice(0, 10), to: w.unavailable_to.slice(0, 10) })),
      ...breakdownWindows(b.data ?? [], today),
    ],
  };
}
