// ---------------------------------------------------------------------------
// driver-availability.ts — Fleet Module A3: the driver-LEAVE half of the two
// A3 constraints. It is to drivers what fleet-availability.ts is to lorries — a
// thin DB loader over a PURE, unit-tested core, folding a driver's leave into
// the A2 assignment flow so the assigner never auto-crews a driver who is on
// leave that day.
//
// There is NO structured HR leave/attendance source in this ERP (the HR area is
// commission/payout only), so A3 owns the minimal scm.driver_leave table (mig
// 0206): one row per absence, a driver unavailable on every date in
// [start_date, end_date] inclusive. This module loads those rows and exposes:
//   - a PURE predicate (isDriverOnLeave) the assigner uses per group-date, and
//   - a loader (loadDriverLeave) that returns the ranges + a display list of the
//     drivers excluded across a planning window (for excludedDrivers[]).
//
// It writes NOTHING.
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function iso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return ISO_DATE.test(s) ? s : null;
}

/** A driver's date-ranged unavailability. Dates are inclusive YYYY-MM-DD. */
export interface DriverLeaveRange {
  driverId: string;
  from: string;
  to: string;
  reason: string | null;
}

/** A driver excluded from the auto-pick over a planning window (display). */
export interface ExcludedDriver {
  id: string;
  name: string | null;
  from: string;
  to: string;
  reason: string | null;
}

/**
 * PURE. Is this driver on leave on `date`? A driver with any range covering the
 * date (inclusive both ends) is on leave. Deterministic — no clock, no I/O.
 */
export function isDriverOnLeave(
  ranges: readonly DriverLeaveRange[],
  driverId: string,
  date: string,
): boolean {
  for (const r of ranges) {
    if (r.driverId !== driverId) continue;
    if (r.from <= date && date <= r.to) return true;
  }
  return false;
}

/**
 * PURE. The set of driverIds on leave on `date`. Convenience over
 * isDriverOnLeave for callers that want a whole-day snapshot.
 */
export function driversOnLeave(
  ranges: readonly DriverLeaveRange[],
  date: string,
): Set<string> {
  const s = new Set<string>();
  for (const r of ranges) {
    if (r.from <= date && date <= r.to) s.add(r.driverId);
  }
  return s;
}

type Row = Record<string, unknown>;
function dual<T = unknown>(r: Row, camel: string, snake: string): T | undefined {
  return (r[camel] ?? r[snake]) as T | undefined;
}

/**
 * Load driver-leave ranges overlapping [from, to] and the excluded-driver
 * display list (name-resolved). `sb` is the scm-scoped PostgREST client
 * (c.get('supabase')). A missing table (fresh env) degrades to "no leave" — the
 * safe direction (no driver is wrongly excluded), never a throw.
 *
 * Overlap test: a range [start_date, end_date] overlaps the window when
 * start_date <= to AND end_date >= from.
 */
export async function loadDriverLeave(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  opts: { from: string; to: string },
): Promise<{ ranges: DriverLeaveRange[]; excludedDrivers: ExcludedDriver[] }> {
  const { from, to } = opts;
  let leaveRows: Row[] = [];
  try {
    const { data } = await sb.from('driver_leave')
      .select('driver_id, start_date, end_date, reason')
      .lte('start_date', to)
      .gte('end_date', from);
    leaveRows = (data ?? []) as Row[];
  } catch {
    leaveRows = [];
  }
  if (leaveRows.length === 0) return { ranges: [], excludedDrivers: [] };

  const ranges: DriverLeaveRange[] = [];
  for (const r of leaveRows) {
    const driverId = String(dual(r, 'driverId', 'driver_id') ?? '');
    const f = iso(dual(r, 'startDate', 'start_date'));
    const t = iso(dual(r, 'endDate', 'end_date'));
    if (!driverId || !f || !t) continue;
    ranges.push({ driverId, from: f, to: t, reason: (dual(r, 'reason', 'reason') as string | null) ?? null });
  }

  // Resolve names for the display list. Best-effort — an unresolved name still
  // reports the exclusion (id-less rows are skipped above).
  const ids = [...new Set(ranges.map((r) => r.driverId))];
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const { data } = await sb.from('drivers').select('id, name').in('id', ids);
      for (const d of (data ?? []) as Row[]) nameById.set(String(d.id), String(d.name ?? ''));
    } catch { /* names are decoration */ }
  }

  const excludedDrivers: ExcludedDriver[] = ranges.map((r) => ({
    id: r.driverId,
    name: nameById.get(r.driverId) ?? null,
    from: r.from,
    to: r.to,
    reason: r.reason,
  }));

  return { ranges, excludedDrivers };
}
