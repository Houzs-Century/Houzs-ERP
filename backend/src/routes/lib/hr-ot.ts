/* Pure overtime-claim rules (HC-0125). A worker reports OT as one or more
 * windows on a work date ("20:30-21:30 rushed an order"); a supervisor confirms.
 * Paid OT for a day is the sum of the CONFIRMED windows' minutes. Tested without
 * a database. */
import { hhmmToMin } from "../../scm/shared/hr-pay-rules";

export type OtStatus = "PENDING" | "CONFIRMED" | "REJECTED";
const MAX_SEGMENT_MIN = 16 * 60;

/** Parse a worker's "HH:MM" overtime window into minutes from midnight of the
 *  work date. An end at or before the start crosses midnight (e.g. 23:30-00:30),
 *  so it rolls to the next day and end_min exceeds 1440. */
export function parseOtSegment(
  startHHMM: string,
  endHHMM: string,
): { ok: true; startMin: number; endMin: number } | { ok: false; message: string } {
  const s = hhmmToMin(startHHMM);
  const eRaw = hhmmToMin(endHHMM);
  if (s == null || !Number.isFinite(s)) return { ok: false, message: "Start time is HH:MM, e.g. 20:30." };
  if (eRaw == null || !Number.isFinite(eRaw)) return { ok: false, message: "End time is HH:MM, e.g. 21:30." };
  if (s >= 1440) return { ok: false, message: "Start time must be on the work date." };
  const e = eRaw <= s ? eRaw + 1440 : eRaw;
  if (e - s < 1) return { ok: false, message: "End time must be after the start time." };
  if (e - s > MAX_SEGMENT_MIN) return { ok: false, message: "One overtime block is at most 16 hours. Split it into separate blocks." };
  return { ok: true, startMin: s, endMin: e };
}

/** Minutes in one stored segment (end_min already rolled past 1440 if overnight). */
export const segmentMinutes = (seg: { start_min: number; end_min: number }): number => seg.end_min - seg.start_min;

/** Total CONFIRMED overtime minutes across claim rows (e.g. for one employee-day). */
export function confirmedOtMinutes(rows: ReadonlyArray<{ status: string; start_min: number; end_min: number }>): number {
  let total = 0;
  for (const r of rows) if (r.status === "CONFIRMED") total += r.end_min - r.start_min;
  return total;
}

// ── Punch-derived overtime (HC-0125 hybrid, owner 2026-11-20) ────────────────
// The owner reversed the report-a-window model: overtime hours are now AUTO-
// COMPUTED from the day's punch (the span a worker was present, less their
// standard working day and the unpaid break), recorded as ONE pending claim a
// supervisor still confirms before it pays. The confirm gate is unchanged, so a
// punch that merely ran long never pays OT on its own.

/** Overtime minutes a day's punch earns: the present span over the standard
 *  working day and the unpaid break, rounded to the minute, never negative. Uses
 *  the SAME standardWorkMin / lunchMin the attendance view and docks already use,
 *  so a late start eats into it exactly as it shortens the regular day. */
export function punchOtMinutes(spanMin: number, standardWorkMin: number, lunchMin: number): number {
  return Math.max(0, Math.round(spanMin - standardWorkMin - lunchMin));
}

/** Where the auto claim's window sits: from the shift end for its minutes. The
 *  minutes (end - start) are what pays; the window is the honest label for a
 *  worker who stayed past knock-off. */
export function autoOtWindow(shiftEndMin: number, otMin: number): { startMin: number; endMin: number } {
  return { startMin: shiftEndMin, endMin: shiftEndMin + otMin };
}

export type AutoOtPlan =
  | { kind: "none" }
  | { kind: "delete"; id: number }
  | { kind: "insert"; startMin: number; endMin: number }
  | { kind: "update"; id: number; startMin: number; endMin: number };

/* What the punch sync should do with the single AUTO claim for an employee-day,
 * given the AUTO claim already there (if any) and whether a human has REPORTED
 * overtime for the same day. Keeps the books to at most one live OT figure per
 * day, so payroll (which sums every confirmed claim) can never double-pay:
 *
 *   - A human-reported claim (pending or confirmed) OWNS the day: the auto
 *     figure stands aside. Any pending auto claim is removed; a reported one is
 *     the precise record of split or outside-shift windows a single punch cannot
 *     show (the case the owner built reporting for).
 *   - A supervisor's decision on the auto claim is final: a confirmed or
 *     rejected auto claim is left as it is, never re-raised or overwritten from a
 *     later re-sync (the sync runs on every punch and page load).
 *   - Otherwise the auto claim tracks the punch: inserted when OT appears,
 *     refreshed while it is still pending, removed when the punch no longer earns
 *     any (a corrected or forgotten punch).
 */
export function planAutoOtClaim(input: {
  existingAuto: { id: number; status: string } | null;
  reportedOwnsDay: boolean;
  shiftEndMin: number;
  otMin: number;
}): AutoOtPlan {
  const { existingAuto, reportedOwnsDay, shiftEndMin, otMin } = input;
  const pendingAuto = existingAuto && existingAuto.status === "PENDING" ? existingAuto : null;
  if (existingAuto && existingAuto.status !== "PENDING") return { kind: "none" };
  if (reportedOwnsDay || otMin <= 0) return pendingAuto ? { kind: "delete", id: pendingAuto.id } : { kind: "none" };
  const { startMin, endMin } = autoOtWindow(shiftEndMin, otMin);
  return pendingAuto ? { kind: "update", id: pendingAuto.id, startMin, endMin } : { kind: "insert", startMin, endMin };
}
