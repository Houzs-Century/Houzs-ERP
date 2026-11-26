
export type CrewKind = 'driver' | 'helper';

/** A leave row as /driver-leave returns it (mig 0206 + 0208 driver/helper XOR). */
export interface CrewLeaveRow {
  driverId: string | null;
  helperId: string | null;
  startDate: string;
  endDate: string;
  reason: string | null;
}

/** The covering range when a crew member is on leave on a date. */
export interface CrewLeaveHit {
  from: string;
  to: string;
  reason: string | null;
}

/**
 * PURE. The leave range covering this crew member on `date`, or null.
 *
 * Inclusive on both ends and compared as ISO strings — byte-identical semantics
 * to isDriverOnLeave / isHelperOnLeave in scm/lib/driver-availability.ts. A blank
 * id or date can never match, so a half-filled form does not grey out the list.
 */
export function findCrewLeave(
  rows: readonly CrewLeaveRow[] | undefined,
  kind: CrewKind,
  id: string | null | undefined,
  date: string | null | undefined,
): CrewLeaveHit | null {
  if (!rows || !id || !date) return null;
  for (const r of rows) {
    const owner = kind === 'driver' ? r.driverId : r.helperId;
    if (owner !== id) continue;
    if (r.startDate <= date && date <= r.endDate) {
      return { from: r.startDate, to: r.endDate, reason: r.reason };
    }
  }
  return null;
}

/** PURE. Convenience boolean over findCrewLeave. */
export function isCrewOnLeave(
  rows: readonly CrewLeaveRow[] | undefined,
  kind: CrewKind,
  id: string | null | undefined,
  date: string | null | undefined,
): boolean {
  return findCrewLeave(rows, kind, id, date) !== null;
}

/**
 * PURE. The suffix shown beside an on-leave name in a picker — the reason when
 * one was recorded, so the dispatcher can weigh MC against annual leave without
 * leaving the screen.
 */
export function crewLeaveLabel(hit: CrewLeaveHit | null): string {
  if (!hit) return '';
  return hit.reason ? `on leave — ${hit.reason}` : 'on leave';
}
